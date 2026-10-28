import { frameBlob } from '../konva/videoFrameReader'
import { notifyInTimeline } from './timelineNotice'
import type { CanvasStore } from '../konva/canvasStore'
import type { CanvasItem } from '../konva/types'
import { captureFrameToCanvas } from '../konva/videoFrameCapture'
import { boardMediaUploader } from '../konva/boardUploader'
import type { CanvasMediaUploader } from '../konva/cropApply'

// Кадр из клипа в заданной точке. Снимаем в браузере: файл уже загружен для
// превью, и гонять его через сервер ради одного кадра незачем — плюс кадр
// получается ровно тот, который человек видит в окне.

/** Отдельный <video> вместо того, что показывает оверлей: перемотка ради
 *  снимка не должна дёргать картинку под курсором. */
export async function captureVideoFrameAt(
  store: CanvasStore,
  item: CanvasItem,
  time: number,
  video?: HTMLVideoElement | null,
  upload: CanvasMediaUploader = boardMediaUploader(),
): Promise<void> {
  if (!item.src) return
  const src = item.src
  try {
    const id = await captureFrameToCanvas(
      store,
      item,
      async () => {
        const { blob, width, height } = await frameBlob(src, time, { video })
        return { blob, width, height, name: `frame${time.toFixed(2)} s.png` }
      },
      upload,
    )
    notifyInTimeline({
      kind: 'success',
      message: `Frame ${time.toFixed(2)} s — on canvas`,
      replaceKey: 'timeline-frame',
      ...(id ? { action: { label: 'Cancel', run: () => store.removeItems([id]) } } : {}),
    })
  } catch (error) {
    notifyInTimeline({
      kind: 'error',
      message: error instanceof Error ? error.message : 'Failed to capture frame',
      replaceKey: 'timeline-frame',
    })
  }
}
