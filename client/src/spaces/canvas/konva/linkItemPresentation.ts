import type { CanvasLinkData } from './types'
import { systemErrorMessage } from '../../../ui/systemMessage'

/**
 * Что делает главная кнопка карточки. Вид отдельно от подписи: LinkItem
 * сравнивал подписи строками, а по ним нельзя отличить «нельзя нажимать» от
 * «можно» — и любая переформулировка молча ломала бы поведение.
 */
export type LinkPrimaryKind = 'download' | 'downloading' | 'login' | 'retry-login'

export interface LinkCardPresentation {
  source: string
  title: string
  shortUrl: string
  openLabel: 'Open link'
  primaryAction: string
  primaryKind: LinkPrimaryKind
  previewStatus?: string
  canRetryPreview: boolean
  /** Подсказка под ссылкой, пока открыто окно входа. */
  loginHint?: string
}

export function linkCardPresentation(
  link: CanvasLinkData,
  options: { loginOpened?: boolean } = {},
): LinkCardPresentation {
  let shortUrl = link.normalizedUrl || link.url
  try {
    const parsed = new URL(shortUrl)
    shortUrl = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    // Исходный URL всё равно остаётся доступен для исправления/повтора.
  }
  // Площадка отказала из-за входа — карточка предлагает войти ПРЯМО ТУТ, а не
  // отправляет человека в настройки: это рабочее действие, а не настройка.
  const needsLogin = Boolean(link.needsLogin) && link.state === 'error'
  const primaryKind: LinkPrimaryKind = link.activeImportId
    ? 'downloading'
    : needsLogin
      ? (options.loginOpened ? 'retry-login' : 'login')
      : 'download'
  const label: Record<LinkPrimaryKind, string> = {
    download: 'Download',
    downloading: 'Downloading…',
    login: `Sign in on ${link.sourceLabel}`,
    'retry-login': 'I’m signed in — retry',
  }
  return {
    source: link.sourceLabel,
    title: link.title || 'Media from link',
    shortUrl,
    openLabel: 'Open link',
    primaryAction: label[primaryKind],
    primaryKind,
    previewStatus: link.state === 'loading-preview'
      ? 'Loading preview…'
      : link.state === 'error'
        ? systemErrorMessage(link.error, 'Failed to load preview')
        : undefined,
    // Повторять превью, когда нужен вход, бессмысленно: ответ будет тот же,
    // пока человек не войдёт. Кнопка тут одна, и она про вход.
    canRetryPreview: link.state === 'error' && !needsLogin,
    loginHint: primaryKind === 'retry-login'
      ? 'Sign in in the window that opens, then click “I’m signed in — retry”'
      : undefined,
  }
}
