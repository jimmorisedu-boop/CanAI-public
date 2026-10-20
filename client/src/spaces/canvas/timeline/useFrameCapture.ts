import { useEffect, useMemo, useState } from 'react'
import type { CanvasStore } from '../konva/canvasStore'
import type { CanvasItem } from '../konva/types'
import type { CanvasMediaUploader } from '../konva/cropApply'
import { FrameCaptureQueue, type FrameCaptureRecord } from './frameCaptureQueue'
import { makeFrameCaptureWork } from './captureWorker'
import { boardMediaUploader, getBoardUploadTarget } from '../konva/boardUploader'
import {
  NO_SELECTION,
  captureOutcome,
  selectedFrameId,
  selectionAfterCapture,
  selectionOf,
  type CaptureOutcome,
  type FrameSelection,
} from './frameSelection'

// Хук полки кадров: держит очередь захвата для одного клипа и отдаёт её
// записи + действия. Используется и оверлеем компьютера, и планшетной правкой.
// Вся тяжёлая логика — в чистом FrameCaptureQueue (тестируемом); правила
// выбора кадра — в frameSelection.ts. Здесь только связка с холстом и
// жизненный цикл.

export type { CaptureOutcome } from './frameSelection'

export interface UseFrameCapture {
  records: readonly FrameCaptureRecord[]
  open: boolean
  setOpen(open: boolean): void
  /**
   * Снять кадр в точке (дедуп сам разберётся). Возвращает исход: поставлен в
   * очередь или такой кадр уже есть; null — клипа нет, снимать нечего.
   * Снятый (или найденный как дубль) кадр становится выбранным.
   */
  capture(time: number): CaptureOutcome | null
  /** Выбранный на полке кадр; null — ничего не выбрано. */
  selectedId: string | null
  select(id: string | null): void
  retry(id: string): void
  cancel(id: string): void
  /** Убрать запись с полки вовсе (выбор, если он был на ней, снимается). */
  drop(id: string): void
  clearSaved(): void
}

export function useFrameCapture(
  store: CanvasStore,
  item: CanvasItem | null,
  opts?: { upload?: CanvasMediaUploader },
): UseFrameCapture {
  const [openValue, setOpenValue] = useState(false)
  const [records, setRecords] = useState<readonly FrameCaptureRecord[]>([])
  const [selection, setSelection] = useState<FrameSelection>(NO_SELECTION)

  // Очередь живёт, пока есть цель (клип). Новый клип — новая очередь: снимки
  // прошлой правки не должны ни липнуть к этой полке, ни тратиться повторно.
  const queue = useMemo(() => new FrameCaptureQueue(), [item?.id])

  useEffect(() => {
    const unsubscribe = queue.subscribe((next) => setRecords(next))
    return () => unsubscribe()
  }, [queue])

  // снятие с доски / закрытие режима — отменяем всё, что ещё едет
  useEffect(() => () => queue.clear(), [queue])

  const uploader = opts?.upload ?? boardMediaUploader()

  return {
    records,
    open: openValue,
    setOpen: setOpenValue,
    capture: (time) => {
      if (!item) return null
      const board = getBoardUploadTarget()?.id
      const outcome = captureOutcome(queue.enqueue(
        {
          itemId: item.id,
          assetId: item.assetId,
          assetRevision: item.assetRevision,
          assetChecksum: item.assetChecksum,
          src: item.src,
          board,
        },
        time,
        makeFrameCaptureWork(store, item, {
          video: undefined,
          upload: uploader,
          board,
        }),
      ))
      setSelection(selectionAfterCapture(queue, outcome))
      return outcome
    },
    selectedId: selectedFrameId(selection, queue, records),
    select: (id) => setSelection(selectionOf(queue, id)),
    retry: (id) => {
      if (!item) return
      queue.retry(id, makeFrameCaptureWork(store, item, {
        video: undefined,
        upload: uploader,
        board: getBoardUploadTarget()?.id,
      }))
    },
    cancel: (id) => queue.cancel(id),
    drop: (id) => queue.drop(id),
    clearSaved: () => queue.clear(),
  }
}
