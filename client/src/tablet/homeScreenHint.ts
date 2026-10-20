// Подсказка «положите CanAI на домашний экран».
//
// Не украшение: только у страницы, добавленной на экран «Домой», ландшафт
// держится по-настоящему (манифест), пропадает адресная строка и доске
// достаётся заметно больше высоты. Но подсказка обязана уметь исчезать
// навсегда — иначе она из совета превращается в помеху.

const DISMISS_KEY = 'canai-tablet-home-hint'

export interface HomeScreenContext {
  /** Страница уже открыта как приложение (с домашнего экрана). */
  standalone: boolean
  /** Человек закрыл подсказку раньше. */
  dismissed: boolean
  /** Safari на iPad — только там есть «На экран «Домой»». */
  appleTouch: boolean
}

export function shouldShowHomeScreenHint(context: HomeScreenContext): boolean {
  if (context.standalone) return false
  if (context.dismissed) return false
  return context.appleTouch
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  // display-mode знают все, `navigator.standalone` — только Safari, и он
  // единственный источник правды для страницы с домашнего экрана на iPadOS.
  const asApp = window.matchMedia?.('(display-mode: standalone)').matches ?? false
  const appleFlag = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return asApp || appleFlag
}

export function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  // iPadOS с 13-й версии представляется «Macintosh», отличает его только
  // наличие сенсорного ввода.
  const ua = navigator.userAgent
  const iOsLike = /iPad|iPhone|iPod/.test(ua)
  const iPadOs = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
  return iOsLike || iPadOs
}

export function homeScreenHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    // Приватный режим и запрет на хранилище не должны ронять экран.
    return false
  }
}

export function dismissHomeScreenHint(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // Не сохранилось — подсказка вернётся в следующий раз, это не поломка.
  }
}
