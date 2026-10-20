import type { ConfirmRequest } from './confirmBus'
import { formatExactUsd } from './money'
import type { PricingMode } from '../types'

export interface QuotePresentationInput {
  amountUsd: number
  quantity?: number
  model?: string
  pricingMode?: PricingMode
  guaranteed?: boolean
  /** A metered quote whose amount is an estimate settled by actual usage. */
  meteredUncapped?: boolean
  /** Aggregate quote contains both fixed and provider-settled components. */
  mixedPricing?: boolean
  quantityLabel?: string
}

/**
 * Cloud only calls a metered amount a ceiling when the quote explicitly
 * marks it as guaranteed. Older quotes keep the exact-price wording.
 */
export function isFalMeteredQuote(
  quote: Pick<QuotePresentationInput, 'pricingMode' | 'guaranteed' | 'meteredUncapped'> | null | undefined,
): boolean {
  return quote?.pricingMode === 'fal-metered'
    && quote.meteredUncapped !== true
    && quote.guaranteed === true
}

/** A metered quote that is settled by actual usage and has no ceiling. */
export function isUncappedMeteredQuote(
  quote: Pick<QuotePresentationInput, 'pricingMode' | 'meteredUncapped'> | null | undefined,
): boolean {
  return quote?.pricingMode === 'fal-metered' && quote.meteredUncapped === true
}

/**
 * Decide whether a set of per-job quotes crosses the server's aggregate
 * confirmation threshold. New servers include that threshold on every quote;
 * an explicit zero means there is no aggregate threshold. If any quote comes
 * from an older server without the field, retain the historical paid-batch
 * confirmation so a series cannot silently multiply its total.
 */
export function aggregateQuoteNeedsConfirmation(
  quotes: ReadonlyArray<{ amountMicro?: unknown; confirmAboveMicro?: unknown }>,
): boolean {
  if (quotes.length === 0) return false
  let totalMicro = 0
  const amountsValid = quotes.every((quote) => {
    if (typeof quote.amountMicro !== 'number' || !Number.isSafeInteger(quote.amountMicro) || quote.amountMicro < 0) {
      return false
    }
    const next = totalMicro + quote.amountMicro
    if (!Number.isSafeInteger(next)) return false
    totalMicro = next
    return true
  })
  const thresholdsKnown = amountsValid && quotes.every((quote) => (
    typeof quote.confirmAboveMicro === 'number'
    && Number.isSafeInteger(quote.confirmAboveMicro)
    && quote.confirmAboveMicro >= 0
  ))
  if (!thresholdsKnown) return quotes.length > 1 && totalMicro > 0
  const positiveThresholds = quotes
    .map((quote) => quote.confirmAboveMicro as number)
    .filter((threshold) => threshold > 0)
  return positiveThresholds.length > 0 && totalMicro > Math.min(...positiveThresholds)
}

/** Price shown beside a model or action button. */
export function formatPriceAmount(
  amountUsd: number,
  pricingMode?: PricingMode,
  meteredUncapped = false,
): string {
  const exact = formatExactUsd(amountUsd)
  if (meteredUncapped) return `≈ ${exact}`
  return pricingMode === 'fal-metered' ? `up to ${exact}` : exact
}

/** Price and explanatory copy for the shared Cloud generation confirmation. */
export function quoteConfirmationRequest(input: QuotePresentationInput): ConfirmRequest {
  const capped = isFalMeteredQuote(input)
  const uncapped = isUncappedMeteredQuote(input)
  const metered = capped || uncapped
  const mixedPricing = metered && input.mixedPricing === true
  const amount = formatExactUsd(input.amountUsd)
  const quantity = Number.isSafeInteger(input.quantity) && (input.quantity ?? 0) > 0
    ? input.quantity!
    : 1
  const quantityLabel = input.quantityLabel ?? 'Results'

  if (!metered) {
    return {
      title: `Run for ${amount}?`,
      rows: [
        ['Model', input.model || 'model'],
        [quantityLabel, String(quantity)],
      ],
      confirmLabel: `Run for ${amount}`,
    }
  }

  if (uncapped) {
    return {
      title: `Run for about ${amount}?`,
      detail: `This is an estimate; the actual generation cost is charged after it completes.`
        + (mixedPricing ? ' Some work in this run is billed differently.' : ''),
      rows: [
        ['Model', input.model || 'model'],
        [quantityLabel, String(quantity)],
        ['Estimate', amount],
      ],
      confirmLabel: `Run for about ${amount}`,
    }
  }

  // ⚠️ Здесь человек отвечает на ОДИН вопрос: сколько это может стоить. Прежний
  // текст отвечал на него в последнюю очередь и чужими словами — «резерв»,
  // «фактическая стоимость fal.ai», «итоговое списание не превысит этот
  // предел», — а «лишнее вернётся» повторялось трижды подряд. Сумма при этом
  // стояла в четырёх местах. У большинства моделей цена твёрдая и окно короткое,
  // поэтому длинное окно вылезало ровно на одной модели и читалось как сбой
  // (жалоба 09.09.2026 «непонятное сообщение при генерации GPT Image»).
  // Осталось два факта: спишут по факту и не больше этой суммы.
  return {
    title: `Run for no more than ${amount}?`,
    detail: `The actual generation cost is charged, up to this amount.`
      + ` We hold the full amount while it runs; the rest returns to your balance, including on cancellation.`
      + (mixedPricing ? ' Some work in this run has a fixed price, some is metered.' : ''),
    rows: [
      ['Model', input.model || 'model'],
      [quantityLabel, String(quantity)],
      ['No more than', amount],
    ],
    confirmLabel: `Run for no more than ${amount}`,
  }
}

/**
 * Подсказка над ценой в кнопке «Создать» — одна на компьютер и планшет.
 *
 * ⚠️ Пояснение тарифа (`pricingNote`: «оплата по фактическому расходу fal»,
 * «себестоимость маршрута без наценки») живёт ЗДЕСЬ, а не абзацем в
 * промпт-баре. Абзацем оно выходило без единого правила в стилях — браузерным
 * кеглем среди рабочих элементов, и человек видел вместо цены длинное
 * сообщение (жалоба 21.09.2026 со снимками сетевой доски: «почему такое
 * сообщение, а не цена?»). Пояснение уступает место рабочим элементам.
 */
export function priceBadgeTitle(
  model: { pricingMode?: PricingMode; meteredUncapped?: boolean; pricingNote?: string } | null | undefined,
): string {
  const base = model?.pricingMode === 'fal-metered' && !model.meteredUncapped
    ? 'Maximum generation reserve'
    : 'Estimated generation price'
  const note = model?.pricingNote?.trim()
  return note ? `${base}. ${note}` : base
}
