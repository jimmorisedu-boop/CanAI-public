import type { CanvasActionPreparationState } from './useCanvasActionPreparation'
import { formatPriceAmount } from '../../ui/quotePresentation'
import { systemErrorMessage, systemStatusMessage } from '../../ui/systemMessage'

export function CanvasActionPreparationReview({
  state,
  onAccept,
  onConfirmQuote,
  onCancel,
  onDismiss,
}: {
  state: CanvasActionPreparationState
  onAccept(text: string): void
  onConfirmQuote(): void
  onCancel(): void
  onDismiss(): void
}) {
  if (state.phase === 'idle') return null
  const quoteAmount = state.quote
    ? formatPriceAmount(state.quote.amountUsd, state.quote.pricingMode, state.quote.meteredUncapped)
    : null
  if (state.phase === 'quote') {
    return (
      <div className="action-dock-preparation action-dock-preparation-quote" role="alert">
        <span>Assistant preparation · {quoteAmount ?? '$—'}</span>
        <button type="button" className="ui-btn primary" onClick={onConfirmQuote}>Confirm</button>
        <button type="button" className="ui-btn quiet" onClick={onDismiss}>Cancel</button>
      </div>
    )
  }
  if (state.phase === 'review' && state.resultText) {
    return (
      <div className="action-dock-preparation action-dock-preparation-review" role="status" aria-live="polite">
        <div className="action-dock-preparation-copy">
          <span className="action-dock-preparation-label">Assistant's draft</span>
          <span>{state.resultText}</span>
        </div>
        <button type="button" className="ui-btn primary" onClick={() => onAccept(state.resultText ?? '')}>Use prompt</button>
        <button type="button" className="ui-btn quiet" onClick={onDismiss}>Cancel</button>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className="action-dock-preparation action-dock-preparation-error" role="alert">
        <span>{systemErrorMessage(state.error, "Failed to prepare request")}</span>
        <button type="button" className="ui-btn quiet" onClick={onDismiss}>Close</button>
      </div>
    )
  }
  return (
    <div className="action-dock-preparation" role="status" aria-live="polite">
      <span>{systemStatusMessage(state.progressText ?? undefined, "Assistant is preparing text…")}</span>
      <span className="action-dock-preparation-price">
        {quoteAmount ?? "price based on token consumption"}
      </span>
      <button type="button" className="ui-btn quiet" onClick={onCancel}>Stop</button>
    </div>
  )
}
