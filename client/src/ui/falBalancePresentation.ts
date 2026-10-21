import { systemErrorMessage } from './systemMessage'
import { t } from '../i18n/translate.js'

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
      label: t('Demo'),
      tooltip: t('Demo mode: paid fal.ai calls are disabled'),
    }
  }

  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency
  if (balance != null) {
    return {
      label: `${symbol}${balance.toFixed(2)}`,
      tooltip: t('fal.ai balance: {0}{1} {2} (click for spending history)', { 0: symbol, 1: balance.toFixed(2), 2: currency }),
    }
  }

  if (errorMsg?.includes('not permitted')) {
    return {
      label: t('No billing'),
      tooltip: t('fal.ai: {0} (click for details)', { 0: systemErrorMessage(errorMsg) }),
    }
  }

  if (errorMsg?.includes('не установлен') || errorMsg?.includes('not configured') || errorMsg?.includes('not set')) {
    return {
      label: t('No key'),
      tooltip: t('fal.ai: {0} (click for details)', { 0: systemErrorMessage(errorMsg) }),
    }
  }

  return {
    label: t('—'),
    tooltip: errorMsg
      ? t('fal.ai: {0} (click for details)', { 0: systemErrorMessage(errorMsg) })
      : t('Checking fal.ai balance…'),
  }
}
