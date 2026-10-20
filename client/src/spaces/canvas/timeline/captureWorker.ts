// Рабочий захвата кадра для очереди (FrameCaptureQueue). Здесь — весь
// browser-specific код: frameBlob (декодер), upload и постановка готового кадра
// на холст с записью provenance (CanvasItem.timelineCapture). Сам менеджмент
// фаз/дедупа — в frameCaptureQueue.ts (чистый, тестируемый).

import { frameBlob, type VideoFrame } from '../konva/videoFrameReader'
import { captureFrameToCanvas } from '../konva/videoFrameCapture'
import type { CanvasStore } from '../konva/canvasStore'
import type { CanvasItem } from '../konva/types'
import type { CanvasMediaUploader } from '../konva/cropApply'
import type { CaptureRunContext, FrameCaptureWork } from './frameCaptureQueue'

export function makeFrameCaptureWork(
  store: CanvasStore,
  source: CanvasItem,
  opts: {
    video?: HTMLVideoElement | null
    upload: CanvasMediaUploader
    board?: string
    /** Декодер кадра. По умолчанию настоящий; подмена нужна проверке без DOM. */
    decode?: (src: string, time: number, options: { video?: HTMLVideoElement | null; timeoutMs?: number }) => Promise<VideoFrame>
  },
): FrameCaptureWork {
  const decode = opts.decode ?? frameBlob
  return async (ctx: CaptureRunContext): Promise<{ itemId?: string; url?: string }> => {
    const src = source.src
    if (!src) throw new Error('Clip has no file')
    ctx.emitPhase('seeking')
    // ✂️ Снимок — в отдельном декодере, чтобы не дёргать картинку под курсором.
    // Время передаём ЗАМОРОЖЕННОЕ: живой currentTime после seek уже уехал.
    const { blob, width, height } = await decode(src, ctx.frozenTime, {
      video: opts.video,
      timeoutMs: 15_000,
    })
    if (ctx.signal.aborted) throw abortError()
    ctx.emitPhase('encoding')
    const name = `frame${ctx.frozenTime.toFixed(2)} s.png`
    ctx.emitPhase('uploading')
    const id = await captureFrameToCanvas(store, source, async () => ({ blob, width, height, name }), opts.upload)
    if (ctx.signal.aborted) throw abortError()
    if (id) {
      // Происхождение кадра — в metadata объекта (раздел 11 ТЗ). Свойство
      // обычное, поэтому проходит через обычный item-mutation/serialization.
      store.updateItem(id, {
        timelineCapture: {
          originBoard: opts.board,
          originItemId: source.id,
          originAssetId: source.assetId,
          originAssetRevision: source.assetRevision,
          originChecksum: source.assetChecksum,
          time: ctx.frozenTime,
          resultItemId: id,
          createdAt: Date.now(),
        },
      }, false)
    }
    // ⚠️ Адрес обязан доехать до очереди: полка рисует по нему миниатюру, а
    // «Скачать» и клавиша D берут файл из записи (`resultUrl`). Раньше
    // возвращался один itemId — у готового кадра спиннер крутился вечно, а
    // скачать его было нельзя. Берём `src` созданного объекта: это тот же
    // адрес, что на доске.
    return { itemId: id ?? undefined, url: id ? store.getItem(id)?.src : undefined }
  }
}

function abortError(): Error {
  const error = new Error('Frame capture canceled')
  error.name = 'AbortError'
  return error
}