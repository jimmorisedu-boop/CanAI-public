// Как объяснить состояние компонента обработки видео словами. Отдельно от
// компонента — чтобы формулировки и правила показа кнопки можно было
// проверить тестом, а не глазами в модалке.

export interface FfmpegStateResponse {
  state: 'ready' | 'missing' | 'downloading' | 'unsupported' | 'failed'
  source?: 'runtime' | 'system'
  percent?: number
  message?: string
  /** Есть ли откуда качать. false — сборка приезжает вместе с приложением
   *  (macOS), и кнопки быть не должно. Поле новое: старый сервер его не
   *  пришлёт, поэтому отсутствие читаем как «качать можно» — как было. */
  downloadable?: boolean
}

export interface MediaToolsView {
  /** Короткий статус справа от заголовка. */
  label: string
  tone: 'ok' | 'warn' | 'danger' | 'neutral'
  /** Пояснение под заголовком; null — объяснять нечего. */
  note: string | null
  /** Подпись кнопки; null — кнопки нет. */
  action: string | null
  busy: boolean
}

export function mediaToolsView(state: FfmpegStateResponse | null): MediaToolsView {
  if (!state) {
    return { label: 'Checking…', tone: 'neutral', note: null, action: null, busy: true }
  }

  if (state.state === 'ready') {
    // Разница между «своя копия» и «системный» важна не из любопытства: на
    // машине разработчика системный найдётся сам, и без этой строчки легко
    // собрать дистрибутив, у которого компонента нет вовсе.
    return state.source === 'system'
      ? {
          label: 'System',
          tone: 'ok',
          note: 'Using ffmpeg installed on the system. There is no copy in the app folder; download one on another computer.',
          action: 'Download a copy',
          busy: false,
        }
      : {
          label: 'Ready',
          tone: 'ok',
          note: 'Lives in the app folder and travels with it.',
          action: null,
          busy: false,
        }
  }

  if (state.state === 'downloading') {
    return {
      label: `${state.percent ?? 0}%`,
      tone: 'neutral',
      note: 'Downloading component — about 40 MB. You can keep working.',
      action: null,
      busy: true,
    }
  }

  if (state.state === 'failed') {
    return {
      label: 'Download failed',
      tone: 'danger',
      note: state.message || 'Could not download component.',
      action: 'Try again',
      busy: false,
    }
  }

  if (state.state === 'unsupported') {
    return {
      label: 'Unavailable',
      tone: 'warn',
      note: 'No build is available for this system — install ffmpeg and ffprobe yourself.',
      action: null,
      busy: false,
    }
  }

  if (state.downloadable === false) {
    // Не «система не поддержана»: здесь ffmpeg работает, он просто должен был
    // лежать в папке с самого начала. Значит и совет другой — не «скачайте», а
    // «распакуйте заново».
    return {
      label: 'Missing from folder',
      tone: 'warn',
      note: 'Video processing ships with the app. The file is missing; extract the archive again. Nothing needs downloading.',
      action: null,
      busy: false,
    }
  }

  return {
    label: 'Not installed',
    tone: 'warn',
    note: 'Needed for audio and video: trimming, splitting shots, and extracting tracks.',
    action: 'Download',
    busy: false,
  }
}

/** Опрашивать состояние есть смысл только пока идёт закачка. */
export function shouldPollMediaTools(state: FfmpegStateResponse | null): boolean {
  return state?.state === 'downloading'
}
