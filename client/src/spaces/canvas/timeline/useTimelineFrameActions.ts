import { useRef } from 'react'
import type { CanvasStore } from '../konva/canvasStore'
import { notifyInTimeline } from './timelineNotice'
import { pickFrameTarget } from './timelineStatus'
import { timecode } from './timelineTimecode'
import type { UseFrameCapture } from './useFrameCapture'

/** Скачать по ссылке через временный <a download>: файл уже на сервере. */
function anchorDownload(url: string, name: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * Действия над кадрами полки: «на холст» (G), «скачать» (D), «убрать».
 *
 * G и D без явного id работают с ВЫБРАННЫМ кадром, а если выбора нет — с
 * последним сохранённым. На кадре, который не готов, они ничего не делают, но
 * говорят об этом в строке состояния: нажатие без ответа читается как
 * сломанная кнопка.
 */
export function useTimelineFrameActions({
  store,
  frames,
  openOnCanvas,
}: {
  store: CanvasStore
  frames: UseFrameCapture
  /** Показать настоящий объект на холсте (презентация «canvas»). */
  openOnCanvas(): void
}) {
  // Действия зовут и клавиши (одна подписка на всю жизнь окна), и кнопки: свежее
  // состояние берём из ref, а не из замыкания, снятого при подписке.
  const latest = useRef({ store, frames, openOnCanvas })
  latest.current = { store, frames, openOnCanvas }

  function show(id: string | null): void {
    const { store, frames, openOnCanvas } = latest.current
    const target = pickFrameTarget(frames.records, id ?? frames.selectedId, 'show')
    if (!target.ok) {
      notifyInTimeline(target.notice)
      return
    }
    const { record } = target
    // Кадр могли убрать с холста руками: полка про это не знает.
    if (!record.resultItemId || !store.getItem(record.resultItemId)) {
      notifyInTimeline({
        kind: 'info',
        tone: 'warn',
        message: `Frame ${timecode(record.requestedTime)} is no longer on the canvas`,
        replaceKey: 'timeline-frame-show',
      })
      return
    }
    frames.select(record.id)
    store.revealItems([record.resultItemId])
    openOnCanvas()
  }

  function download(id: string | null): void {
    const { frames } = latest.current
    const target = pickFrameTarget(frames.records, id ?? frames.selectedId, 'download')
    if (!target.ok) {
      notifyInTimeline(target.notice)
      return
    }
    const { record } = target
    if (!record.resultUrl) return
    frames.select(record.id)
    anchorDownload(record.resultUrl, `frame${record.requestedTime.toFixed(2)} s.png`)
    notifyInTimeline({
      kind: 'success',
      message: `Frame ${timecode(record.requestedTime)} — PNG downloading`,
      replaceKey: 'timeline-frame-download',
    })
  }

  /** Убрать кадр: и с полки, и с холста — тот же объект, что лежит на доске. */
  function remove(id: string): void {
    const { store, frames } = latest.current
    const record = frames.records.find((candidate) => candidate.id === id)
    if (record?.resultItemId) store.removeItems([record.resultItemId])
    frames.drop(id)
  }

  return { show, download, remove }
}
