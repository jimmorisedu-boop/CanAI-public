import { api } from '../../../api'
import { notifyInTimeline } from '../timeline/timelineNotice'
import { adoptForBoard } from './boardUploader'
import { AUDIO_ITEM_HEIGHT, AUDIO_ITEM_WIDTH, audioTitle } from './audioMeta'
import type { CanvasStore } from './canvasStore'

const TOAST_KEY = 'extract-audio'

// «Отделить звук» — дорожка становится отдельным объектом рядом с клипом.
// Оригинал НЕ трогаем: он оплачен, и превращать его в немой ради того, чтобы
// достать копию звука, было бы обменом не в пользу пользователя.

/** Куда положить дорожку: под клипом, по его левому краю. Так видно, чей это
 *  звук, и объект не перекрывает соседей справа, где обычно встают генерации. */
export function audioDropRect(item: { x: number; y: number; w: number; h: number }): {
  x: number
  y: number
  w: number
  h: number
} {
  return {
    x: item.x,
    y: item.y + item.h + 24,
    w: Math.min(AUDIO_ITEM_WIDTH, Math.max(AUDIO_ITEM_WIDTH, item.w)),
    h: AUDIO_ITEM_HEIGHT,
  }
}

export async function extractAudioFromItem(store: CanvasStore, itemId: string): Promise<void> {
  const item = store.getItem(itemId)
  if (!item || item.kind !== 'video' || !item.src) return

  notifyInTimeline({ kind: 'info', message: 'Extracting audio…', replaceKey: TOAST_KEY })
  try {
    const result = await api.extractAudio(item.src)
    // ⚠️ Звук сделал НАШ ffmpeg и положил к себе. На сетевой доске такая
    // ссылка не значит ничего — переселяем файл к остальной доске.
    const media = await adoptForBoard(result, `${audioTitle(item.name)} — audio.mp3`)
    const id = store.addItem(
      {
        kind: 'audio',
        ...audioDropRect(item),
        src: media.url,
        ...(media.assetId ? { assetId: media.assetId } : {}),
        mime: media.mime,
        name: `${audioTitle(item.name)} — audio`,
        duration: result.duration,
        peaks: result.peaks,
        // Родословная: сравнение узнаёт, из чего это сделано (см. pickBaseline)
        referenceIds: [item.id],
      },
      { select: true },
    )
    notifyInTimeline({
      kind: 'success',
      message: 'Audio separated; the clip is unchanged',
      replaceKey: TOAST_KEY,
      action: { label: 'Cancel', run: () => store.removeItems([id]) },
    })
  } catch (error) {
    notifyInTimeline({
      kind: 'error',
      message: error instanceof Error ? error.message : 'Failed to extract audio',
      replaceKey: TOAST_KEY,
    })
  }
}
