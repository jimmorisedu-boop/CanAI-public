export interface CanvasVideoElement {
  currentTime: number
  duration: number
  ended: boolean
  pause(): void
  play(): Promise<void>
}

export interface CanvasVideoPlaybackView {
  setPlaying(value: boolean): void
  setCurrentTime(value: number): void
  redraw(): void
}

export interface CanvasVideoPlaybackCommands {
  start(): void
  pause(): void
  finish(): void
  release(): void
}

interface ActivePlayback {
  id: string
  video: CanvasVideoElement
  view: CanvasVideoPlaybackView
}

const activeByScope = new WeakMap<object, ActivePlayback>()

function release(scope: object, id: string): void {
  if (activeByScope.get(scope)?.id === id) activeByScope.delete(scope)
}

function stopAndRewind(active: ActivePlayback): void {
  active.video.pause()
  active.video.currentTime = 0
  active.view.setCurrentTime(0)
  active.view.setPlaying(false)
  active.view.redraw()
}

function claim(scope: object, active: ActivePlayback): void {
  const previous = activeByScope.get(scope)
  if (previous && previous.id !== active.id) stopAndRewind(previous)
  activeByScope.set(scope, active)
}

export function createCanvasVideoPlaybackCommands(
  scope: object,
  videoId: string,
  video: CanvasVideoElement,
  view: CanvasVideoPlaybackView,
): CanvasVideoPlaybackCommands {
  const active = { id: videoId, video, view }

  return {
    start() {
      if (video.ended || video.currentTime >= (video.duration || Infinity)) {
        video.currentTime = 0
        view.setCurrentTime(0)
        view.redraw()
      }
      claim(scope, active)
      view.setPlaying(true)
      void video.play().catch(() => {
        release(scope, videoId)
        view.setPlaying(false)
      })
    },
    pause() {
      video.pause()
      view.setPlaying(false)
      release(scope, videoId)
    },
    finish() {
      view.setPlaying(false)
      release(scope, videoId)
    },
    release() {
      release(scope, videoId)
    },
  }
}

/**
 * Что делает клик по видео на холсте.
 *
 * Первый клик ТОЛЬКО выделяет. Раньше он сразу запускал воспроизведение, и
 * любое обращение к клипу — выделить, чтобы перетащить, взять референсом или
 * открыть правку — начиналось со звука, который потом приходилось гасить.
 * Играть просят вторым кликом по уже выделенному.
 *
 * Shift+клик набирает выделение и к воспроизведению отношения не имеет.
 */
export function shouldTogglePlaybackOnClick(input: {
  wasSelected: boolean
  shiftKey: boolean
}): boolean {
  if (input.shiftKey) return false
  return input.wasSelected
}
