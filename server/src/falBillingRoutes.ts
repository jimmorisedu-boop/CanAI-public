import { Router } from 'express'
import { config } from './config.js'

const BILLING_HISTORY_PAGE_SIZE = 10

interface FalBillingEvent {
  request_id?: string
  endpoint_id?: string
  timestamp?: string
  cost_estimate_nano_usd?: number
}

interface FalBillingHistoryResponse {
  billing_events?: FalBillingEvent[]
  next_cursor?: string | null
  has_more?: boolean
  error?: { message?: string }
}

export function createFalBillingHistoryUrl(cursor?: string): string {
  const url = new URL('https://api.fal.ai/v1/models/billing-events')
  url.searchParams.set('limit', String(BILLING_HISTORY_PAGE_SIZE))
  if (cursor) url.searchParams.set('cursor', cursor)
  return url.toString()
}

export function normalizeFalBillingHistoryPage(data: FalBillingHistoryResponse) {
  const events = (Array.isArray(data.billing_events) ? data.billing_events : []).map((item, index) => {
    const costUsd = typeof item.cost_estimate_nano_usd === 'number'
      ? item.cost_estimate_nano_usd / 1e9
      : 0
    return {
      id: item.request_id ?? `evt-${index}-${item.timestamp ?? ''}`,
      endpoint: item.endpoint_id ?? 'fal-ai',
      cost: costUsd,
      time: item.timestamp ?? new Date().toISOString(),
    }
  })
  const nextCursor = data.has_more === true
    && typeof data.next_cursor === 'string'
    && data.next_cursor.length > 0
    ? data.next_cursor
    : null
  return { events, nextCursor, hasMore: nextCursor !== null }
}

// Баланс и история трат fal.ai (прокси с кэшем — ключ наружу не отдаём).
export const falBillingRouter = Router()

let balanceCache: { balance: number; currency: string; timestamp: number } | null = null
const BALANCE_CACHE_TTL = 60_000 // 60 секунд

// смена ключа делает кэш недействительным: сразу после «Сохранить» клиент
// проверяет ключ запросом баланса — он должен уйти в fal, а не в старый кэш
export function resetFalBalanceCache(): void {
  balanceCache = null
}

falBillingRouter.get('/fal-balance', async (_req, res) => {
  if (!config.falKey) {
    return res.json({ balance: null, error: 'fal.ai key is not set' })
  }
  const now = Date.now()
  if (balanceCache && now - balanceCache.timestamp < BALANCE_CACHE_TTL) {
    return res.json({ balance: balanceCache.balance, currency: balanceCache.currency })
  }
  try {
    const response = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', {
      headers: { Authorization: `Key ${config.falKey}` },
    })
    const data = (await response.json().catch(() => null)) as {
      credits?: { current_balance?: number; currency?: string }
      error?: { message?: string }
    } | null

    if (data?.credits && typeof data.credits.current_balance === 'number') {
      balanceCache = {
        balance: data.credits.current_balance,
        currency: data.credits.currency || 'USD',
        timestamp: now,
      }
      return res.json({ balance: balanceCache.balance, currency: balanceCache.currency })
    }

    if (balanceCache) {
      return res.json({ balance: balanceCache.balance, currency: balanceCache.currency })
    }

    if (data?.error?.message) {
      return res.json({ balance: null, error: data.error.message })
    }
    res.json({ balance: null, error: 'Could not read the balance' })
  } catch (err) {
    if (balanceCache) {
      return res.json({ balance: balanceCache.balance, currency: balanceCache.currency })
    }
    res.json({ balance: null, error: err instanceof Error ? err.message : 'Request failed' })
  }
})

falBillingRouter.get('/fal-history', async (req, res) => {
  const rawCursor = req.query.cursor
  if (rawCursor !== undefined && (typeof rawCursor !== 'string' || rawCursor.length === 0 || rawCursor.length > 2048)) {
    return res.status(400).json({
      events: [],
      nextCursor: null,
      hasMore: false,
      error: 'Invalid history cursor',
    })
  }
  if (!config.falKey) {
    return res.json({ events: [], nextCursor: null, hasMore: false, error: 'fal.ai key is not set' })
  }
  try {
    const response = await fetch(createFalBillingHistoryUrl(rawCursor), {
      headers: { Authorization: `Key ${config.falKey}` },
    })
    const data = (await response.json().catch(() => null)) as FalBillingHistoryResponse | null

    if (data?.billing_events && Array.isArray(data.billing_events)) {
      return res.json(normalizeFalBillingHistoryPage(data))
    }

    if (data?.error?.message) {
      return res.json({ events: [], nextCursor: null, hasMore: false, error: data.error.message })
    }

    res.json({ events: [], nextCursor: null, hasMore: false, error: 'Could not load history' })
  } catch (err) {
    res.json({
      events: [],
      nextCursor: null,
      hasMore: false,
      error: err instanceof Error ? err.message : 'Request failed',
    })
  }
})
