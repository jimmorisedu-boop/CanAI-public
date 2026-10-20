/**
 * Formats an exact USD amount returned by a server quote.
 *
 * Quote amounts are represented in microdollars on the wire, so two decimal
 * places can hide a real charge ($0.125 becoming $0.13). Keep at least cents
 * for familiar prices and retain all meaningful digits up to the wire's six
 * decimal places.
 */
export function formatExactUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '$—'
  const micro = Math.round(amount * 1_000_000)
  if (!Number.isSafeInteger(micro)) return '$—'
  const fixed = (micro / 1_000_000).toFixed(6)
  const trimmed = fixed.replace(/0+$/u, '').replace(/\.$/u, '')
  const [whole, fraction = ''] = trimmed.split('.')
  return `$${whole}.${fraction.padEnd(2, '0')}`
}
