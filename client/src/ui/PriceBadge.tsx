import { IconCoins } from './icons'
import type { PricingMode } from '../types'
import { useT } from '../i18n/context.js'

function localizePriceTitle(title: string, translate: (message: string) => string): string {
  for (const key of ['Estimated price per run', 'Estimated generation price', 'Maximum generation reserve']) {
    if (title === key) return translate(key)
    const prefix = `${key}. `
    if (title.startsWith(prefix)) return `${translate(key)}. ${title.slice(prefix.length)}`
  }
  return title
}

export function PriceBadge({
  amount,
  precision = 2,
  title = 'Estimated price per run',
  className = '',
  variant = 'badge',
  pricingMode,
  meteredUncapped = false,
}: {
  amount: number | null
  precision?: number
  title?: string
  className?: string
  variant?: 'badge' | 'action'
  pricingMode?: PricingMode
  meteredUncapped?: boolean
}) {
  const t = useT()
  const pending = amount == null
  const capped = pricingMode === 'fal-metered' && !meteredUncapped
  const displayTitle = localizePriceTitle(title, t)
  const value = pending
    ? '$…'
    : capped
      ? t('up to ${0}', { 0: amount.toFixed(precision) })
      : `${variant === 'action' && !meteredUncapped ? '' : '≈ '}$${amount.toFixed(precision)}`
  const accessibleTitle = pending ? t('Calculating price') : displayTitle
  return (
    <span
      className={`price-badge${variant === 'action' ? ' is-action' : ''}${pending ? ' is-pending' : ''} ${className}`.trim()}
      title={accessibleTitle}
      aria-label={pending ? accessibleTitle : t('{0}: {1}', { 0: displayTitle, 1: value })}
    >
      {variant !== 'action' && <IconCoins size={12} weight="fill" className="badge-icon" aria-hidden="true" />}
      <span className="badge-value">{value}</span>
    </span>
  )
}
