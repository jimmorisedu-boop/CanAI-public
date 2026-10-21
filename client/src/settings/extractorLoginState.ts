import { t } from '../i18n/translate.js'

// Формулировки блока «Вход на площадки». Отдельным модулем — по той же
// причине, что и остальные: правила проверяет тест, а не глаз в модалке.

export type CookieMode = 'none' | 'app' | 'file'

export interface LoginStatusView {
  label: string
  tone: 'idle' | 'success'
  note: string
}

/**
 * Что показать о текущем входе.
 *
 * ⚠️ «Вход выполнен» мы НЕ утверждаем никогда. Сервер видит только файл cookies
 * в профиле, а он появляется в тот миг, когда окно открылось, — то есть ещё до
 * того, как человек ввёл пароль. Утверждать по такому признаку удачный вход
 * значит врать ровно в том месте, где человек потом будет искать причину
 * отказа; настоящую проверку делает сама площадка при скачивании.
 */
export function loginStatus(
  mode: CookieMode,
  input: { available: boolean; signedIn: boolean; file?: string | null } = { available: true, signedIn: false },
): LoginStatusView {
  if (mode === 'app') {
    return {
      label: input.signedIn ? t('Through app window') : t('Sign-in window not opened yet'),
      tone: input.signedIn ? 'success' : 'idle',
      note: input.signedIn
        ? t('Downloads use the sign-in saved in the app window. If the site rejects it, the link card will say so.')
        : t('Click “Sign in”, complete sign-in in the window, and downloads will use your account.'),
    }
  }
  if (mode === 'file') {
    return {
      label: t('From cookies file'),
      tone: input.file ? 'success' : 'idle',
      note: input.file
        ? t('Sign-in uses {0}', { 0: input.file })
        : t('Choose a cookies file exported by a browser extension.'),
    }
  }
  return {
    label: t('Not set'),
    tone: 'idle',
    note: t('Sites are accessed anonymously. Vimeo does not serve video this way; sign-in is required.'),
  }
}

/** Чем открывать окно входа, если Firefox не нашёлся. Тупика быть не должно. */
export function noBrowserNote(available: boolean): string | null {
  return available
    ? null
    : t('The sign-in window uses Firefox, which is not installed. Install Firefox or choose a cookies file below.')
}

/**
 * Кнопки входа в НАСТРОЙКАХ. Здесь только Vimeo — площадка, которая требует
 * вход сегодня.
 *
 * ⚠️ Это не значит, что остальные не поддержаны: сервер принимает и YouTube, и
 * Instagram, и TikTok, и если какая-то из них упрётся во вход, предложит его
 * САМА КАРТОЧКА той ссылки. Ряд из четырёх кнопок в настройках — это четыре
 * приглашения сделать лишнее для трёх площадок, которые и так отдают видео.
 */
export const LOGIN_PROVIDERS: Array<{ id: string; label: string }> = [
  { id: 'vimeo', label: 'Vimeo' },
]

// ── браузер для входа (портативный компонент) ────────────────────────────

export interface LoginBrowserState {
  state: 'ready' | 'missing' | 'downloading' | 'unsupported' | 'failed'
  source?: 'runtime' | 'system'
  percent?: number
  message?: string
}

export interface LoginBrowserView {
  label: string
  tone: 'ok' | 'warn' | 'danger' | 'neutral'
  note: string | null
  /** Подпись кнопки; null — кнопки нет. */
  action: string | null
  busy: boolean
}

/**
 * Как объяснить состояние браузера словами. Отдельно от компонента — чтобы
 * формулировки проверял тест, а не глаз в модалке (то же, что у ffmpeg).
 *
 * ⚠️ «Недоступен» и «не скачан» — РАЗНЫЕ вещи, и советы у них разные. На маке
 * мы Firefox не качаем, но и тупика нет: он ставится обычным способом, и
 * приложение найдёт его само. Предлагать там кнопку «Скачать» значило бы звать
 * к тому, чего не произойдёт.
 */
export function loginBrowserView(state: LoginBrowserState | null): LoginBrowserView {
  if (!state) return { label: t('Checking…'), tone: 'neutral', note: null, action: null, busy: true }

  if (state.state === 'ready') {
    return state.source === 'system'
      ? {
          label: t('System'),
          tone: 'ok',
          // Та же причина, что у ffmpeg: на своей машине системный найдётся
          // сам, и без этой строчки легко решить, что у покупателя тоже всё есть.
          note: t('Sign-in opens in Firefox installed on the system. There is no copy in the app folder; download one on another computer.'),
          action: t('Download a copy'),
          busy: false,
        }
      : {
          label: t('Ready'),
          tone: 'ok',
          note: t('Lives in the app folder and travels with it.'),
          action: null,
          busy: false,
        }
  }

  if (state.state === 'downloading') {
    return {
      label: `${state.percent ?? 0}%`,
      tone: 'neutral',
      note: t('Downloading browser — about 93 MB. You can keep working.'),
      action: null,
      busy: true,
    }
  }

  if (state.state === 'failed') {
    return {
      label: t('Download failed'),
      tone: 'danger',
      note: state.message || t('Could not download browser.'),
      action: t('Try again'),
      busy: false,
    }
  }

  if (state.state === 'unsupported') {
    return {
      label: t('Unavailable'),
      tone: 'warn',
      note: t('We do not download a browser for this system. Install Firefox normally and the app will find it.'),
      action: null,
      busy: false,
    }
  }

  return {
    label: t('Not downloaded'),
    tone: 'warn',
    note: t('Needed to sign in to a site from the app. It downloads from Mozilla and is not bundled.'),
    action: t('Download (≈93 MB)'),
    busy: false,
  }
}

/** Опрашивать состояние есть смысл только пока идёт закачка. */
export function shouldPollLoginBrowser(state: LoginBrowserState | null): boolean {
  return state?.state === 'downloading'
}
