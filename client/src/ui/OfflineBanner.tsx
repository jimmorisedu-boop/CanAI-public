import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { getOnline, OFFLINE_DETAIL, OFFLINE_TITLE, subscribeOnline } from './network'

// Полоса «нет интернета» поверх всего. Не блокирует ничего: работа с холстом
// продолжается, а «Сгенерировать» и макросы не получают disabled — инвариант
// продукта. Прежде обрыв связи выглядел как 30 секунд тишины и техническая
// ошибка в конце (аудит F-21).
export function OfflineBanner() {
  const online = useSyncExternalStore(subscribeOnline, getOnline, () => true)

  // класс на <html>, а не inline-стиль: полоса нарисована порталом в body и
  // сдвинуть приложение сама не может, а накрывать шапку ей нельзя
  useEffect(() => {
    document.documentElement.classList.toggle('is-offline', !online)
    return () => document.documentElement.classList.remove('is-offline')
  }, [online])

  if (online) return null
  return createPortal(
    <div className="offline-banner" role="status">
      {/* тон точкой, как у всех прочих сообщений: крупная иконка кричала
          громче самого текста (DESIGN.md) */}
      <span className="offline-banner-dot" aria-hidden="true" />
      <strong>{OFFLINE_TITLE}</strong>
      <span>{OFFLINE_DETAIL}</span>
    </div>,
    document.body,
  )
}
