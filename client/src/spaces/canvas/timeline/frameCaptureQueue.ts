// Очередь захвата кадров из клипа в таймлайне (раздел 10 ТЗ).
//
// Кадр снимают, чтобы ПОТОМ из него мог быть один объект на холсте; но кликают
// по кнопке, пока видео ещё думает, — и каждый кадр живёт своей жизнью:
// ждёт seek, рисует, едет на сервер. Всё это асинхронно, и режим правки не
// должен переставать работать, пока кадры доснимаются. Очередь держит каждый
// запрос от заморозки времени до результата/ошибки и сообщает о каждом шаге
// подписчикам (полка кадров рисует по нему статусы).
//
// Правила (раздел 10/11):
//  - `requestedTime` замораживается СРАЗУ на клике и не читается из mutable
//    currentTime после await seek (иначе быстрые клики сохранили бы один и тот
//    же поздний кадр);
//  - кадр дедуплицируется по (исходник, asset-identity, время);
//  - фазы: queued → seeking → encoding → uploading → saved, из любой рабочей
//    фазы — error, отмена до ack — cancelled;
//  - работа идёт через существующий frameBlob + boardMediaUploader + заглушку
//    captureFrameToCanvas — НЕ новый API;
//  - provenance записывается в metadata результата (CanvasItem.timelineCapture).
//
// Модуль чистый и подписочный: не зависит от React, поэтому очередь можно
// проверить без DOM (см. frameCaptureQueue.test.ts).

import { canonicalCaptureKey } from './timelineCanvasMath'

export type CapturePhase =
  | 'queued'
  | 'seeking'
  | 'encoding'
  | 'uploading'
  | 'saved'
  | 'error'
  | 'cancelled'

export interface FrameCaptureSourceIdentity {
  itemId: string
  assetId?: string
  assetRevision?: number
  assetChecksum?: string
  src?: string
  board?: string
}

export interface FrameCaptureRecord {
  /** локальный id записи очереди. */
  id: string
  source: FrameCaptureSourceIdentity
  /** точное замороженное время кадра (секунды). */
  requestedTime: number
  /** настоящий PTS от декодера, если тот его отдал (иначе undefined). */
  decodedPts?: number
  phase: CapturePhase
  error?: string
  /** id созданного CanvasItem после commit. */
  resultItemId?: string
  resultUrl?: string
  createdAt: number
  /** ключ дедупликации. */
  dedupKey: string
}

export type CaptureConsumer = (records: readonly FrameCaptureRecord[]) => void

/**
 * Работа для одного кадра: снять, загрузить и поставить на холст. Свойства:
 *  - frozenTime — замороженное время (не читать живой currentTime);
 *  - emitPhase — просить очередь перевести запись в эту фазу;
 *  - signal — отмена (запрос снят / ушли с доски);
 *  Возвращает {itemId, url} после успешного commit/ack.
 */
export interface CaptureRunContext {
  frozenTime: number
  emitPhase: (phase: CapturePhase) => void
  signal: AbortSignal
}

export type FrameCaptureWork = (ctx: CaptureRunContext) => Promise<{ itemId?: string; url?: string }>

let recordCursor = 0

interface PendingRun {
  signal: AbortController
  work: FrameCaptureWork
  started: boolean
}

export class FrameCaptureQueue {
  private records: FrameCaptureRecord[] = []
  private consumers = new Set<CaptureConsumer>()
  private runs = new Map<string, PendingRun>()

  private emit(): void {
    const snapshot = [...this.records]
    for (const consumer of this.consumers) consumer(snapshot)
  }

  subscribe(consumer: CaptureConsumer): () => void {
    this.consumers.add(consumer)
    consumer([...this.records])
    return () => { this.consumers.delete(consumer) }
  }

  getRecords(): readonly FrameCaptureRecord[] {
    return [...this.records]
  }

  private live(id: string): FrameCaptureRecord | undefined {
    return this.records.find((r) => r.id === id)
  }

  private __claim(id: string, phase: CapturePhase): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, phase } : r))
    this.emit()
  }

  private patch(id: string, mut: Partial<FrameCaptureRecord>): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, ...mut } : r))
  }

  enqueue(
    source: FrameCaptureSourceIdentity,
    requestedTime: number,
    work: FrameCaptureWork,
  ): { record: FrameCaptureRecord; duplicate: boolean } {
    const dedupKey = canonicalCaptureKey(
      { source: source.itemId, assetId: source.assetId, checksum: source.assetChecksum, revision: source.assetRevision },
      undefined,
      requestedTime,
    )
    const existing = this.records.find((r) => r.dedupKey === dedupKey
      && (r.phase === 'queued' || r.phase === 'seeking' || r.phase === 'encoding' || r.phase === 'uploading' || r.phase === 'saved'))
    if (existing) return { record: existing, duplicate: true }

    recordCursor += 1
    const record: FrameCaptureRecord = {
      id: `fc-${recordCursor}`,
      source,
      requestedTime,
      phase: 'queued',
      createdAt: Date.now(),
      dedupKey,
    }
    this.records = [...this.records, record]
    const controller = new AbortController()
    this.runs.set(record.id, { signal: controller, work, started: false })
    this.emit()
    void this.execute(record, controller)
    return { record, duplicate: false }
  }

  private async execute(record: FrameCaptureRecord, controller: AbortController): Promise<void> {
    const run = this.runs.get(record.id)
    if (!run || run.signal !== controller || run.started) return
    run.started = true
    // ⚠️ Отмена не останавливает декодер на лету: он доживает свой await и ещё
    // может сообщить фазу или результат. Если за это время кадр повторили
    // (`retry`), у записи уже новая попытка со своим контроллером, и вести
    // прежней обязаны молчать — иначе «отменён» от старой попытки затирал бы
    // фазу новой, а её запуск пропадал бы из `runs`, и отменить её стало бы нечем.
    const current = (): boolean => this.runs.get(record.id)?.signal === controller
    try {
      const result = await run.work({
        frozenTime: record.requestedTime,
        emitPhase: (phase) => {
          if (controller.signal.aborted || !current()) return
          this.__claim(record.id, phase)
        },
        signal: controller.signal,
      })
      if (!current()) return
      if (controller.signal.aborted) {
        this.patch(record.id, { phase: 'cancelled' })
        return
      }
      this.patch(record.id, {
        phase: 'saved',
        resultItemId: result.itemId,
        resultUrl: result.url,
        error: undefined,
      })
    } catch (error) {
      if (!current()) return
      if (controller.signal.aborted) {
        this.patch(record.id, { phase: 'cancelled' })
      } else {
        this.patch(record.id, {
          phase: 'error',
          error: error instanceof Error ? error.message : 'Failed to capture frame',
        })
      }
    } finally {
      // Запуск снимает ТОЛЬКО его хозяин: после повтора в `runs` лежит уже
      // чужая попытка, и стереть её значило бы лишить её отмены.
      if (current()) {
        this.runs.delete(record.id)
        this.emit()
      }
    }
  }

  /**
   * Отменить кадр по id: если работа ещё не подтвердила upload, запись уходит
   * в cancelled и вызывающий отменяет декодер. Уже `saved` отмене не подлежит.
   */
  cancel(id: string): void {
    const rec = this.live(id)
    if (!rec || rec.phase === 'saved' || rec.phase === 'cancelled') return
    const run = this.runs.get(id)
    run?.signal.abort()
    // execute переведёт в cancelled после выброса; но чтобы статус обновился
    // мгновенно даже до выхода из await, помечаем сразу.
    this.patch(id, { phase: 'cancelled' })
    this.emit()
  }

  /**
   * Повторить кадр после ошибки/отмены. Использует ТОТ ЖЕ dedup-ключ (раздел
   * 10: "error → retry создаёт новую попытку того же request identity, а не
   * новый dedup key") — поэтому дубликата не получится, а в записи остаётся
   * замороженное время исходного запроса.
   */
  retry(id: string, work: FrameCaptureWork): void {
    const rec = this.live(id)
    if (!rec || (rec.phase !== 'error' && rec.phase !== 'cancelled')) return
    const controller = new AbortController()
    this.runs.set(rec.id, { signal: controller, work, started: false })
    this.patch(rec.id, { phase: 'queued', error: undefined })
    this.emit()
    void this.execute(rec, controller)
  }

  clear(): void {
    for (const run of this.runs.values()) run.signal.abort()
    this.runs.clear()
    this.records = []
    this.emit()
  }

  /** Убрать запись с полки вовсе (в т.ч. готовую). Вызывающий удаляет и сам
   *  объект с холста, если он создан. */
  drop(id: string): void {
    const run = this.runs.get(id)
    run?.signal.abort()
    this.runs.delete(id)
    this.records = this.records.filter((r) => r.id !== id)
    this.emit()
  }
}