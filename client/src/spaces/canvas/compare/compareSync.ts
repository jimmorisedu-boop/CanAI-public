// Синхронное воспроизведение нескольких видео. Приём взят из боевого
// видео-просмотрщика пользователя (Lmd_sku, pipeline.html): одно видео
// ВЕДУЩЕЕ, остальные тянутся за ним, и currentTime подтягивается только когда
// расхождение стало заметным. Постоянная запись currentTime дёргает
// воспроизведение и роняет плавность — отсюда порог.

export const DRIFT_THRESHOLD = 0.12 // секунды: меньше — на глаз не видно

// Всё, что нам нужно знать о видео. Обычный HTMLVideoElement подходит под этот
// тип, поэтому логика тестируется без DOM.
export type VideoLike = {
  currentTime: number
  playbackRate: number
  paused: boolean
  readyState: number
}

export type SyncCommand = {
  index: number // позиция в массиве подчинённых
  seekTo?: number // выставить currentTime
  setRate?: number // выставить playbackRate
  play?: boolean // true — играть, false — пауза
}

export type SyncOptions = {
  // resetTime — вернуть всех в начало (смена пары, первый запуск)
  resetTime?: boolean
  // force — подтянуть время независимо от порога (после seek/loadedmetadata)
  force?: boolean
  threshold?: number
}

// Что сделать с подчинёнными, чтобы они шли за ведущим. Возвращаем план, а не
// дёргаем элементы: план легко проверить тестом и легко применить в одном месте.
export function syncPlan(
  primary: VideoLike,
  secondaries: VideoLike[],
  { resetTime = false, force = false, threshold = DRIFT_THRESHOLD }: SyncOptions = {},
): SyncCommand[] {
  const target = resetTime ? 0 : primary.currentTime || 0
  const commands: SyncCommand[] = []

  secondaries.forEach((video, index) => {
    const command: SyncCommand = { index }
    let touched = false

    if (video.playbackRate !== primary.playbackRate) {
      command.setRate = primary.playbackRate
      touched = true
    }

    // readyState < 1 — метаданных ещё нет, currentTime писать некуда:
    // присвоение молча потеряется, а видео потом стартует не с того места
    if (video.readyState >= 1 && shouldSeek(video.currentTime, target, { resetTime, force, threshold })) {
      command.seekTo = target
      touched = true
    }

    if (video.paused !== primary.paused) {
      command.play = !primary.paused
      touched = true
    }

    if (touched) commands.push(command)
  })

  return commands
}

export function shouldSeek(
  current: number,
  target: number,
  { resetTime = false, force = false, threshold = DRIFT_THRESHOLD }: SyncOptions = {},
): boolean {
  if (resetTime || force) return true
  return Math.abs((current || 0) - target) > threshold
}

// Режим «по очереди» для двух видео (у пользователя это `enhance`): вместо двух
// одновременно играет то одно, то другое, каждое С НАЧАЛА. Для одного и того же
// движения так нагляднее — глаз сравнивает память о движении, а не два разных
// таймкода рядом.
export type AlternateState = { playingIndex: 0 | 1 }

export function alternateStep(state: AlternateState | null): {
  playingIndex: 0 | 1
  // индексы, которые надо перемотать в 0 и запустить / поставить на паузу
  playFrom: 0 | 1
  pause: 0 | 1
} {
  const next: 0 | 1 = state?.playingIndex === 0 ? 1 : 0
  return { playingIndex: next, playFrom: next, pause: next === 0 ? 1 : 0 }
}

// Длительности разные — общая шкала идёт по самому длинному, короткое
// замирает на последнем кадре (а не зацикливается, иначе сравнение «уплывает»).
export function timelineDuration(durations: number[]): number {
  const valid = durations.filter((d) => Number.isFinite(d) && d > 0)
  return valid.length ? Math.max(...valid) : 0
}

export function clampToDuration(time: number, duration: number): number {
  if (!(duration > 0)) return 0
  return Math.min(Math.max(time, 0), duration)
}
