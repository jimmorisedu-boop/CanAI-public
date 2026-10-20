import { IconCoins } from './icons'
import type { PricingMode } from '../types'

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
  const pending = amount == null
  const capped = pricingMode === 'fal-metered' && !meteredUncapped
  const value = pending
    ? '$…'
    : capped
      ? `up to $${amount.toFixed(precision)}`
      : `${variant === 'action' && !meteredUncapped ? '' : '≈ '}$${amount.toFixed(precision)}`
  const accessibleTitle = pending ? 'Calculating price' : title
  return (
    <span
      className={`price-badge${variant === 'action' ? ' is-action' : ''}${pending ? ' is-pending' : ''} ${className}`.trim()}
      title={accessibleTitle}
      aria-label={pending ? accessibleTitle : `${title}: ${value}`}
    >
      {variant !== 'action' && <IconCoins size={12} weight="fill" className="badge-icon" aria-hidden="true" />}
      <span className="badge-value">{value}</span>
    </span>
  )
}
