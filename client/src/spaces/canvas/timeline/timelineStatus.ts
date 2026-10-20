import type { CapturePhase, FrameCaptureRecord } from './frameCaptureQueue'
import type { TimelineNotice } from './timelineNotice'
import { timecode } from './timelineTimecode'
import { systemErrorMessage } from '../../../ui/systemMessage'

// Строка состояния транспорта и правила про кадры на полке — чистые функции,
// чтобы их можно было проверить без DOM. Оверлей только рисует результат.

export type StatusTone = 'idle' | 'good' | 'warn' | 'error'

export interface StatusLine {
  text: string
  tone: StatusTone
  action?: { label: string; run(): void }
}

export const STATUS_IDLE = 'Done'

/** Кадр ещё в пути: очередь, поиск, кодирование, загрузка. */
export function isBusyPhase(phase: CapturePhase): boolean {
  return phase === 'queued' || phase === 'seeking' || phase === 'encoding' || phase === 'uploading'
}

export function noticeTone(notice: TimelineNotice): StatusTone {
  if (notice.tone === 'warn') return 'warn'
  if (notice.kind === 'error') return 'error'
  if (notice.kind === 'success') return 'good'
  return 'idle'
}

/**
 * Что показать в строке состояния.
 *
 * Приоритет: свежее сообщение режима → идущее снятие кадра («Кадр … —
 * сохраняю…» живёт, пока кадр в пути, а не гаснет через две секунды вместе с
 * сообщением) → «Готово».
 */
export function statusLine(input: {
  notice: TimelineNotice | null
  records: readonly FrameCaptureRecord[]
}): StatusLine {
  const { notice, records } = input
  if (notice) {
    return {
      text: notice.kind === 'error' ? systemErrorMessage(notice.message) : notice.message,
      tone: noticeTone(notice),
      action: notice.action,
    }
  }
  const busy = records.filter((record) => isBusyPhase(record.phase))
  if (busy.length === 1) {
    return { text: `Frame ${timecode(busy[0].requestedTime)} — saving…`, tone: 'idle' }
  }
  if (busy.length > 1) {
    return { text: `Saving frames: ${busy.length}…`, tone: 'idle' }
  }
  return { text: STATUS_IDLE, tone: 'idle' }
}

/**
 * Сообщение о переходе кадра из одной фазы в другую — чтобы итог снятия
 * («на холсте», «не сохранился») был сказан словами, а не только сменой
 * значка на полке, которая может быть закрыта.
 */
export function frameTransitionNotice(
  before: CapturePhase | undefined,
  record: FrameCaptureRecord,
): TimelineNotice | null {
  if (before === record.phase) return null
  const at = timecode(record.requestedTime)
  if (record.phase === 'saved') {
    return { kind: 'success', message: `Frame ${at} — on canvas`, replaceKey: 'timeline-frame' }
  }
  if (record.phase === 'error') {
    return {
      kind: 'error',
      message: `Frame ${at} — was not saved${record.error ? `: ${systemErrorMessage(record.error)}` : ''}`,
      replaceKey: 'timeline-frame',
    }
  }
  if (record.phase === 'cancelled') {
    return { kind: 'info', message: `Frame ${at} — canceled`, replaceKey: 'timeline-frame' }
  }
  return null
}

export const NO_FRAMES_MESSAGE = 'No frames yet — press F'

export type FrameTargetResult =
  | { ok: true; record: FrameCaptureRecord }
  | { ok: false; notice: TimelineNotice }

/**
 * С каким кадром работают G («на холст») и D («скачать»).
 *
 * Выбранный на полке — он; выбора нет — последний сохранённый (по времени
 * СНЯТИЯ, а не по положению в клипе: «только что снятый» — это ожидание
 * человека). На кадре, который не готов, клавиши ничего не делают, но
 * молчать нельзя: нажатие без ответа читается как сломанная кнопка.
 */
export function pickFrameTarget(
  records: readonly FrameCaptureRecord[],
  selectedId: string | null,
  need: 'show' | 'download',
): FrameTargetResult {
  const selected = selectedId ? records.find((record) => record.id === selectedId) : undefined
  const lastSaved = [...records]
    .filter((record) => record.phase === 'saved')
    .sort((a, b) => a.createdAt - b.createdAt)
    .pop()
  const record = selected ?? lastSaved
  const key = need === 'show' ? 'timeline-frame-show' : 'timeline-frame-download'

  if (!record) {
    return { ok: false, notice: { kind: 'info', tone: 'warn', message: NO_FRAMES_MESSAGE, replaceKey: key } }
  }
  const at = timecode(record.requestedTime)
  if (isBusyPhase(record.phase)) {
    return { ok: false, notice: { kind: 'info', tone: 'warn', message: `Frame ${at} is still saving — please wait`, replaceKey: key } }
  }
  if (record.phase === 'error') {
    return { ok: false, notice: { kind: 'error', message: `Frame ${at} was not saved — retry it from the shelf`, replaceKey: key } }
  }
  if (record.phase === 'cancelled') {
    return { ok: false, notice: { kind: 'info', tone: 'warn', message: `Frame ${at} was canceled — retry it from the shelf`, replaceKey: key } }
  }
  if (need === 'download' && !record.resultUrl) {
    return { ok: false, notice: { kind: 'info', tone: 'warn', message: `Frame ${at} has no file to download yet`, replaceKey: key } }
  }
  if (need === 'show' && !record.resultItemId) {
    return { ok: false, notice: { kind: 'info', tone: 'warn', message: `Frame ${at} is not on the canvas yet`, replaceKey: key } }
  }
  return { ok: true, record }
}

/** Подпись состояния кадра на карточке полки. */
export function frameStatusText(record: FrameCaptureRecord): string {
  if (isBusyPhase(record.phase)) return 'Saving…'
  if (record.phase === 'saved') return 'Saved'
  if (record.phase === 'cancelled') return 'Canceled'
  return record.error ? `Error: ${systemErrorMessage(record.error)}` : 'Error'
}

/** Тон карточки: «сохраняю» — цветом метки, «сохранено» — зелёным, ошибка — опасностью. */
export function frameStatusTone(record: FrameCaptureRecord): 'busy' | 'saved' | 'error' | 'cancelled' {
  if (isBusyPhase(record.phase)) return 'busy'
  if (record.phase === 'saved') return 'saved'
  if (record.phase === 'cancelled') return 'cancelled'
  return 'error'
}

/** Кадры в порядке клипа — так их читают на полке и так стоят метки. */
export function framesByTime(records: readonly FrameCaptureRecord[]): FrameCaptureRecord[] {
  return [...records].sort((a, b) => a.requestedTime - b.requestedTime || a.createdAt - b.createdAt)
}
