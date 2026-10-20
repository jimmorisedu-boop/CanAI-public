import { clampToDuration } from './compareSync'
import { hits } from '../../../ui/hotkeys'

// HTMLVideoElement подходит напрямую; тесты проверяют команды без декодера DOM.
export interface FrameVideo {
  currentTime: number
  duration: number
  readyState: number
  pause(): void
}

export function seekCompareVideos(videos: FrameVideo[], time: number): void {
  for (const video of videos) {
    if (video.readyState < 1 || !Number.isFinite(video.duration)) continue
    try {
      video.currentTime = clampToDuration(time, video.duration)
    } catch {
      /* элемент ещё не готов */
    }
  }
}

export function stepCompareFrames<T extends FrameVideo>(
  videos: T[],
  frames: number,
  fpsFor: (video: T) => number | undefined,
): number | null {
  videos.forEach((video) => video.pause())
  // Как при воспроизведении: общую шкалу ведёт самый длинный ролик.
  const primary = videos.filter((video) => video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0)
    .reduce<T | undefined>((best, video) => !best || video.duration > best.duration ? video : best, undefined)
  if (!primary) return null
  const probed = fpsFor(primary)
  // Тот же запасной FPS, что у таймлайна, пока ffprobe не ответил или не смог
  // определить частоту. Для VFR это шаг по номинальной частоте, не по PTS.
  const fps = probed && Number.isFinite(probed) && probed > 0 && probed < 1000 ? probed : 25
  const lastFrame = Math.max(0, Math.ceil(primary.duration * fps - 1e-6) - 1)
  // Браузер возвращает currentTime с точностью до микросекунд: 71/24
  // становится 2.958333. Допуск нужен во ВРЕМЕНИ, иначе потеряем целый кадр.
  const currentFrame = Math.min(lastFrame, Math.floor((Math.max(0, primary.currentTime) + 1e-6) * fps))
  const nextFrame = Math.max(0, Math.min(lastFrame, currentFrame + frames))
  // В WebM PTS округляются до миллисекунд: 10/24 ещё раньше кадра с PTS
  // 0.417. Берём середину кадра, чтобы декодер показал именно его.
  const time = nextFrame === 0 ? 0 : Math.min((nextFrame + 0.5) / fps, primary.duration - 1e-6)
  seekCompareVideos(videos, time)
  return time
}

export function handleCompareFrameKey(event: KeyboardEvent, stepFrames: (frames: number) => boolean): boolean {
  const target = event.target as HTMLElement | null
  if (event.defaultPrevented || event.isComposing || target?.isContentEditable
    || (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return false
  const direction = hits('compare.frameBack', event) ? -1 : hits('compare.frameForward', event) ? 1 : 0
  if (!direction || !stepFrames(direction * (event.shiftKey ? 10 : 1))) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}
