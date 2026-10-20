import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateQuoteNeedsConfirmation,
  formatPriceAmount,
  isFalMeteredQuote,
  isUncappedMeteredQuote,
  quoteConfirmationRequest,
} from './quotePresentation.js'

test('fixed quote сохраняет точную формулировку подтверждения', () => {
  const request = quoteConfirmationRequest({
    amountUsd: 0.125,
    quantity: 1,
    model: 'Grok',
  })

  assert.equal(request.title, 'Run for $0.125?')
  assert.deepEqual(request.rows, [['Model', 'Grok'], ['Results', '1']])
  assert.equal(request.confirmLabel, 'Run for $0.125')
  assert.equal(request.detail, undefined)
  assert.equal(formatPriceAmount(0.125), '$0.125')
})

/**
 * ⚠️ Окно отвечает на ОДИН вопрос: сколько это может стоить. Прежний текст
 * отвечал на него в последнюю очередь и чужими словами («резерв»,
 * «фактическая стоимость fal.ai», «итоговое списание не превысит этот
 * предел»), трижды повторял «лишнее вернётся» и ставил сумму в четыре места.
 * У большинства моделей цена твёрдая и окно короткое, поэтому длинное
 * вылезало ровно на одной и читалось как сбой (жалоба 09.09.2026
 * «непонятное сообщение при генерации GPT Image»).
 *
 * ⚠️ Прежний тест закреплял именно ту формулировку — тот случай, когда тест
 * защищает то, на что жалуются.
 */
test('потолок цены называется своими словами и ровно один раз', () => {
  const quote = { pricingMode: 'fal-metered' as const, guaranteed: true }
  const request = quoteConfirmationRequest({
    amountUsd: 8,
    quantity: 4,
    model: 'Flare',
    ...quote,
    quantityLabel: 'Задач',
  })

  assert.equal(isFalMeteredQuote(quote), true)
  // У компактной плашки рядом с моделью «до» уместно — там одно слово, не окно.
  assert.equal(formatPriceAmount(2, 'fal-metered'), 'up to $2.00')
  assert.equal(request.title, 'Run for no more than $8.00?')
  assert.deepEqual(request.rows, [
    ['Model', 'Flare'],
    ['Задач', '4'],
    ['No more than', '$8.00'],
  ])
  assert.equal(request.confirmLabel, 'Run for no more than $8.00')
  // Два факта: спишут по факту и не больше этой суммы; про возврат — один раз.
  assert.match(request.detail ?? '', /up to this amount/u)
  assert.match(request.detail ?? '', /rest returns to your balance/u)
  assert.match(request.detail ?? '', /cancellation/u)
  assert.equal((request.detail ?? '').match(/returns/gu)?.length, 1, 'одно обещание возврата, а не три')
  assert.doesNotMatch(request.detail ?? '', /fal\.ai/u, 'человек покупает у команды, а не у поставщика')
  assert.doesNotMatch(request.detail ?? '', /резерв/iu)
})

test('fal-metered без guaranteed не маскируется под потолок', () => {
  const request = quoteConfirmationRequest({
    amountUsd: 2,
    quantity: 1,
    model: 'Flare',
    pricingMode: 'fal-metered',
  })

  assert.equal(isFalMeteredQuote({ pricingMode: 'fal-metered' }), false)
  assert.equal(request.title, 'Run for $2.00?')
  assert.equal(request.detail, undefined)
})

test('uncapped fal-metered показывает оценку и честно объясняет фактическое списание', () => {
  const quote = {
    pricingMode: 'fal-metered' as const,
    guaranteed: false,
    meteredUncapped: true,
  }
  const request = quoteConfirmationRequest({
    amountUsd: 2,
    quantity: 1,
    model: 'Flare',
    ...quote,
  })

  assert.equal(isFalMeteredQuote(quote), false)
  assert.equal(isUncappedMeteredQuote(quote), true)
  assert.equal(formatPriceAmount(2, 'fal-metered', true), '≈ $2.00')
  assert.equal(request.title, 'Run for about $2.00?')
  assert.match(request.detail ?? '', /estimate/u)
  assert.match(request.detail ?? '', /actual generation cost/u)
  assert.doesNotMatch(request.detail ?? '', /no more than|reserve|limit/u)
})

test('aggregate quote policy uses the minimum positive threshold and legacy fallback', () => {
  const quotes = (threshold?: number) => [2_000_000, 2_000_000, 2_000_000, 2_000_000].map((amountMicro) => ({
    amountMicro,
    ...(threshold === undefined ? {} : { confirmAboveMicro: threshold }),
  }))
  assert.equal(aggregateQuoteNeedsConfirmation(quotes(5_000_000)), true)
  assert.equal(aggregateQuoteNeedsConfirmation(quotes(0)), false)
  assert.equal(aggregateQuoteNeedsConfirmation(quotes(10_000_000)), false)
  assert.equal(aggregateQuoteNeedsConfirmation(quotes()), true)
  assert.equal(aggregateQuoteNeedsConfirmation([
    { amountMicro: 8_000_000, confirmAboveMicro: 10_000_000 },
    { amountMicro: 1_000_000, confirmAboveMicro: 5_000_000 },
  ]), true)
})

test('пояснение тарифа живёт в подсказке над ценой, а не абзацем', async () => {
  const { priceBadgeTitle } = await import('./quotePresentation')
  assert.equal(priceBadgeTitle(null), 'Estimated generation price')
  assert.equal(
    priceBadgeTitle({ pricingMode: 'fal-metered', meteredUncapped: true, pricingNote: 'Оплата по фактическому расходу fal.' }),
    'Estimated generation price. Оплата по фактическому расходу fal.',
  )
  assert.equal(priceBadgeTitle({ pricingMode: 'fal-metered' }), 'Maximum generation reserve')
  assert.equal(priceBadgeTitle({ pricingNote: '   ' }), 'Estimated generation price')
})
