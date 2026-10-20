export type TabletVideoState = 'loading' | 'ready' | 'error'

/** Сбой media-запроса не исправляется повтором fetch API: нужен video.load(). */
export function watchTabletVideo(
  video: HTMLVideoElement,
  publish: (state: TabletVideoState) => void,
  events: EventTarget = window,
) {
  let failed = false
  let savedTime: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let loading = false
  const clear = () => { clearTimeout(timer); timer = undefined }
  const fail = () => {
    clear()
    failed = true
    loading = false
    publish('error')
  }
  const wait = () => {
    clear()
    loading = true
    publish('loading')
    timer = setTimeout(fail, 15_000)
  }
  const ready = () => {
    clear()
    loading = false
    failed = false
    publish('ready')
  }
  // Ограничиваем паузу в поступлении данных, а не полное время скачивания.
  // Большой MP4 по медленной сети может исправно грузиться дольше 15 секунд.
  const progress = () => {
    if (!loading) return
    clear()
    timer = setTimeout(fail, 15_000)
  }
  const metadata = () => {
    const target = savedTime ?? (video.currentTime === 0 && video.duration > 0.2 ? 0.1 : video.currentTime)
    savedTime = null
    if (Number.isFinite(target) && target >= 0) {
      try { video.currentTime = Math.min(target, Math.max(0, video.duration - 0.001)) } catch { /* ждём loadeddata */ }
    }
  }
  const retry = () => {
    if (!failed) return
    savedTime = video.currentTime
    failed = false
    wait()
    video.load()
  }
  video.addEventListener('error', fail)
  video.addEventListener('progress', progress)
  video.addEventListener('loadedmetadata', metadata)
  video.addEventListener('loadeddata', ready)
  video.addEventListener('canplay', ready)
  events.addEventListener('online', retry)
  events.addEventListener('focus', retry)
  if (video.error) fail()
  else if (video.readyState >= 2) ready()
  else wait()
  return {
    retry,
    dispose() {
      clear()
      video.removeEventListener('error', fail)
      video.removeEventListener('progress', progress)
      video.removeEventListener('loadedmetadata', metadata)
      video.removeEventListener('loadeddata', ready)
      video.removeEventListener('canplay', ready)
      events.removeEventListener('online', retry)
      events.removeEventListener('focus', retry)
    },
  }
}
