import { systemErrorMessage } from './systemMessage'

type FalBalancePresentationInput = {
  mockMode: boolean
  balance: number | null
  currency: string
  errorMsg: string | null
}
export function falBalancePresentation({
  mockMode,
  balance,
  currency,
  errorMsg,
}: FalBalancePresentationInput): { label: string; tooltip: string } {
  if (mockMode) {
    return {
      label: 'Demo',
      tooltip: 'Demo mode: paid fal.ai calls are disabled',
    }
  }

  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency
  if (balance != null) {
    return {
      label: `${symbol}${balance.toFixed(2)}`,
      tooltip: `fal.ai balance: ${symbol}${balance.toFixed(2)} ${currency} (click for spending history)`,
    }
  }

  if (errorMsg?.includes('not permitted')) {
    return {
      label: 'No billing',
      tooltip: `fal.ai: ${systemErrorMessage(errorMsg)} (click for details)`,
    }
  }

  if (errorMsg?.includes('не установлен') || errorMsg?.includes('not configured') || errorMsg?.includes('not set')) {
    return {
      label: 'No key',
      tooltip: `fal.ai: ${systemErrorMessage(errorMsg)} (click for details)`,
    }
  }

  return {
    label: '—',
    tooltip: errorMsg
      ? `fal.ai: ${systemErrorMessage(errorMsg)} (click for details)`
      : 'Checking fal.ai balance…',
  }
}
