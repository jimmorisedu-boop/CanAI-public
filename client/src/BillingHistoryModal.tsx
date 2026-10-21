import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'
import { api } from './api'
import { IconBalance, IconClose, IconRefresh } from './ui/icons'
import { useDialogFocus } from './ui/dialogFocus'
import { InlineNotice } from './ui/InlineNotice'
import { getIntlLocale } from './i18n/language'
import { useT } from './i18n'

export interface BillingEvent {
  id: string
  endpoint: string
  cost: number
  time: string
}

export function mergeBillingEvents(current: BillingEvent[], incoming: BillingEvent[]): BillingEvent[] {
  const known = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !known.has(item.id))]
}

export function shouldLoadNextBillingPage(
  scroll: { scrollTop: number; clientHeight: number; scrollHeight: number },
  state: { hasMore: boolean; nextCursor: string | null; loading: boolean },
): boolean {
  return state.hasMore
    && state.nextCursor !== null
    && !state.loading
    && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 96
}

export function formatModelName(endpoint: string): string {
  if (endpoint.includes('ideogram')) return 'Ideogram Character Edit'
  if (endpoint.includes('sam-3')) return 'SAM 3 (Segmentation)'
  if (endpoint.includes('any-llm') || endpoint.includes('openrouter/router')) return 'LLM Text / Vision'
  if (endpoint.includes('flux')) return 'Flux Pro'
  if (endpoint.includes('hunyuan')) return 'Hunyuan Video'
  if (endpoint.includes('minimax')) return 'MiniMax Video'
  if (endpoint.includes('kling')) return 'Kling AI Video'
  return endpoint.replace(/^fal-ai\//, '').replace(/[-/]/g, ' ')
}

// Only labels selected from known endpoint families are system UI. A fallback
// endpoint may be a user/configured model name and must remain untouched.
const LOCALIZABLE_MODEL_ENDPOINT = /ideogram|sam-3|any-llm|openrouter\/router|flux|hunyuan|minimax|kling/i

function formatTime(isoStr: string, locale: string = getIntlLocale()): string {
  try {
    const d = new Date(isoStr)
    if (isNaN(d.getTime())) return isoStr
    return d.toLocaleString(locale, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return isoStr
  }
}

export function BillingHistoryModal({
  balance,
  currency,
  onClose,
  onRefreshBalance,
}: {
  balance: number | null
  currency: string
  onClose: () => void
  onRefreshBalance: () => void
}) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [events, setEvents] = useState<BillingEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const requestEpochRef = useRef(0)

  const loadHistory = useCallback(async (cursor: string | null = null) => {
    const append = cursor !== null
    if (append && loadingMoreRef.current) return
    const epoch = append ? requestEpochRef.current : ++requestEpochRef.current
    if (append) {
      loadingMoreRef.current = true
      setLoadingMore(true)
      setLoadMoreError(null)
    } else {
      setLoading(true)
      setError(null)
      setLoadMoreError(null)
    }
    try {
      const res = await api.getFalHistory(cursor ?? undefined)
      if (epoch !== requestEpochRef.current) return
      if (res.error) throw new Error(res.error)
      setEvents((current) => append ? mergeBillingEvents(current, res.events) : res.events)
      setNextCursor(res.nextCursor ?? null)
      setHasMore(res.hasMore === true && Boolean(res.nextCursor))
    } catch (err) {
      if (epoch !== requestEpochRef.current) return
      const message = err instanceof Error && err.message
        ? err.message
        : append
          ? t('Could not load more transactions')
          : t('Could not load transaction history')
      if (append) setLoadMoreError(message)
      else setError(message)
    } finally {
      if (append) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      } else if (epoch === requestEpochRef.current) {
        setLoading(false)
      }
    }
  }, [t])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  function handleHistoryScroll(event: UIEvent<HTMLDivElement>): void {
    const target = event.currentTarget
    if (shouldLoadNextBillingPage(target, {
      hasMore,
      nextCursor,
      loading: loading || loadingMore,
    })) {
      void loadHistory(nextCursor)
    }
  }

  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency

  return (
    <div className="modal-backdrop nodrag" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-card billing-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="billing-history-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title">
            <span className="modal-title-icon" aria-hidden="true">
              <IconBalance size={18} weight="fill" />
            </span>
            <span id="billing-history-title">{t('Transaction history')}</span>
          </div>
          <button className="modal-close-btn icon-btn" onClick={onClose} title={t('Close (Esc)')} aria-label={t('Close')}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="billing-summary-card">
          <div className="billing-summary-info">
            <span className="billing-summary-label">{t('Current balance:')}</span>
            <span className="billing-summary-val">
              {balance != null ? `${symbol}${balance.toFixed(2)} ${currency}` : '—'}
            </span>
          </div>
          <button
            type="button"
            className={`billing-refresh-btn ${loading ? 'spinning' : ''}`}
            onClick={() => {
              void loadHistory()
              onRefreshBalance()
            }}
            disabled={loading}
            title={t('Refresh balance and history')}
          >
            <IconRefresh size={14} className="billing-refresh-icon" />
            <span>{loading ? t('Refreshing…') : t('Refresh')}</span>
          </button>
        </div>

        <div
          className="billing-events-list"
          onScroll={handleHistoryScroll}
          aria-busy={loading || loadingMore}
          aria-label={t('fal.ai transactions')}
        >
          {loading ? (
            <div className="billing-loading">{t('Loading fal.ai transactions…')}</div>
          ) : error ? (
            /* раньше это была просто красная строка: диктор о провале молчал,
               а повторить загрузку было нечем — тупик посреди модалки */
            <InlineNotice
              className="billing-error"
              tone="error"
              title={error}
              action={{ label: t('Retry'), onClick: () => void loadHistory() }}
            />
          ) : events.length === 0 ? (
            <div className="billing-empty">{t('No transactions yet')}</div>
          ) : (
            <>
              {events.map((item) => {
                const isZero = item.cost === 0
                return (
                  <div key={item.id} className="billing-event-row">
                    <div className="billing-event-info">
                      <span className="billing-event-name">
                        {LOCALIZABLE_MODEL_ENDPOINT.test(item.endpoint)
                          ? t(formatModelName(item.endpoint))
                          : formatModelName(item.endpoint)}
                      </span>
                      <span className="billing-event-time">{formatTime(item.time, getIntlLocale())}</span>
                    </div>
                    <div className={`billing-event-cost ${isZero ? 'zero' : 'spent'}`}>
                      {isZero ? '$0.000' : `-${symbol}${item.cost.toFixed(4)}`}
                    </div>
                  </div>
                )
              })}
              {loadingMore && <div className="billing-loading-more" role="status">{t('Loading more…')}</div>}
              {loadMoreError && (
                <InlineNotice
                  className="billing-more-error"
                  tone="error"
                  title={loadMoreError}
                  action={{ label: t('Retry'), onClick: () => void loadHistory(nextCursor) }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
