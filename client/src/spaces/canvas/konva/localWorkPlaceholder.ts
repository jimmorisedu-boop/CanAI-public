import type { CanvasStore } from './canvasStore'
import type { CanvasItem, Placeholder } from './types'
import { newId } from '../../../ui/ids'

/**
 * Заглушка на время работы, которую делает САМО приложение, — скетч, кадр из
 * клипа, применённая обрезка, правка из внешнего редактора.
 *
 * ⚠️ Между нажатием и появлением объекта проходят секунды, и всё это время на
 * холсте не происходит НИЧЕГО (жалоба 09.09.2026: «новый контент долго
 * появляется»). Работы там две, и обе не мгновенные: собрать картинку в
 * натуральном разрешении и — на сетевой доске — отправить её на сервер
 * команды, где счёт идёт на мегабайты. У генерации эта секунда давно занята
 * карточкой со спиннером; здесь её просто не было, хотя ожидание такое же.
 *
 * Механизм берём тот же, что у генерации: заглушка встаёт рядом с исходником,
 * а готовый файл заменяет её НА МЕСТЕ (`resolveJob`). Номер задачи местный —
 * с приставкой `local:`, поэтому в объект он не запишется и наружу не уедет.
 *
 * ⚠️ Заглушка `transient` — она НЕ сохраняется в доску: работа живёт в этой
 * вкладке, и переживший перезагрузку спиннер крутился бы вечно.
 *
 * ⚠️ Результат встаёт РАЗМЕРОМ ИСХОДНИКА, а не общими 440 единицами, как у
 * генерации (жалоба 22.09.2026 со снимком: кадр из уменьшенного ролика вставал
 * огромным, из увеличенного — крошечным). И кадр, и склейка скетча сделаны в
 * натуральном разрешении исходника и в его границах, поэтому та же ширина на
 * доске и есть тот же масштаб. Размер берём у самого исходника, а не просим у
 * вызывающего: иначе каждое новое место забывало бы его передать.
 *
 * ⚠️ Карточка умеет показывать САМУ работу, пока та едет (`preview`, пункт
 * 3.6): обрезка и правка из редактора видны сразу, а загрузка идёт фоном с
 * процентами. Раньше обрезка держала режим открытым всю дорогу файла до
 * сервера и обратно, а правка из редактора появлялась только после загрузки.
 */
export interface LocalWorkPlaceholder {
  /** Куда встанет результат. */
  jobId: string
  /** Готово: объект заменит заглушку на её месте. */
  done(result: { url: string; mime: string; assetId?: string; assetRevision?: number; assetChecksum?: string; width?: number; height?: number }, name: string): Promise<void>
  /** Готово, и объект собран вызывающим (у внешней правки своя пометка сеанса). */
  place(item: Omit<CanvasItem, 'id' | 'x' | 'y' | 'w' | 'h'>): string | null
  /** Ход загрузки — проценты на самой карточке. */
  progress(loaded: number, total: number): void
  /** Работа легла на место исходника (обрезка) — карточка больше не нужна. */
  finish(): void
  /** Не вышло: заглушка исчезает, а причину говорит вызывающий. */
  fail(): void
  /**
   * Карточку убрали с холста (Delete), пока работа шла, — человек от неё
   * отказался. Результат после этого на доску не ставится.
   */
  dropped(): boolean
}

export interface LocalWorkOptions {
  label: string
  anchorId?: string
  /** Карточка ровно здесь, а не рядом с исходником: обрезка ложится на место. */
  rect?: { x: number; y: number; w: number; h: number; rotation?: number }
  /** Размер будущего объекта, если он не совпадает с исходником (правка из редактора). */
  size?: { w: number; aspect: number }
  /** Что показать на карточке, пока работа едет. */
  preview?: Pick<Placeholder, 'previewSrc' | 'previewCrop'>
}

export function startLocalWork(store: CanvasStore, options: LocalWorkOptions): LocalWorkPlaceholder {
  const jobId = `local:${newId()}`
  let slot: string | undefined
  if (options.rect) {
    const { rotation, ...rect } = options.rect
    slot = store.addTransientUploadPending(rect, 'image', options.label, {
      ...options.preview,
      ...(rotation ? { rotation } : {}),
    })
  } else {
    const anchor = options.anchorId ? store.getItem(options.anchorId) : undefined
    const source = anchor && anchor.w > 0 && anchor.h > 0 ? anchor : undefined
    ;[slot] = store.addPendingRow(1, {
      kind: 'image',
      label: options.label,
      anchorIds: options.anchorId ? [options.anchorId] : undefined,
      width: options.size?.w ?? source?.w,
      aspect: options.size?.aspect ?? (source ? source.w / source.h : undefined),
      transient: true,
    })
    if (slot && options.preview) store.updatePending(slot, options.preview, { system: true })
  }
  if (slot) store.setPendingJob(slot, jobId)
  const card = slot
  return {
    jobId,
    done: (result, name) => store.resolveJob(jobId, result, name),
    place: (item) => (card ? store.completeLocalWork(card, item) : null),
    progress: (loaded, total) => {
      if (!card || !(total > 0)) return
      // 100% ещё не «готово»: после загрузки объект встаёт на место, и
      // сотня на висящей карточке читалась бы как зависание.
      store.updatePending(card, { percent: Math.min(99, Math.round((loaded * 100) / total)) }, { system: true })
    },
    finish: () => { if (card) store.dismissPendingById(card) },
    fail: () => { if (card) store.dismissPendingById(card) },
    dropped: () => !card || !store.getPending().some((pending) => pending.id === card),
  }
}
