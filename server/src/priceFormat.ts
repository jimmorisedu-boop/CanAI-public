/** Formats a server quote without hiding fractions smaller than one cent. */
export function formatExactUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$—'
  const micro = Math.round(usd * 1_000_000)
  if (!Number.isSafeInteger(micro)) return '$—'
  const fixed = (micro / 1_000_000).toFixed(6)
  const trimmed = fixed.replace(/0+$/u, '').replace(/\.$/u, '')
  const [whole, fraction = ''] = trimmed.split('.')
  return `$${whole}.${fraction.padEnd(2, '0')}`
}
