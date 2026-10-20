import { OperationState } from '../ui/OperationState'
import type { GalleryFailure } from './galleryAvailability'

export function GalleryFailureState({
  failure,
  retrying,
  onRetry,
}: {
  failure: Exclude<GalleryFailure, null>
  retrying: boolean
  onRetry: () => void
}) {
  const serviceUnavailable = failure.kind === 'service-unavailable'
  return (
    <OperationState
      title={serviceUnavailable ? 'CanAI is temporarily unavailable' : 'Could not load boards'}
      detail={
        serviceUnavailable
          ? 'Start CanAI again with “Start CanAI.bat”, then click “Retry”.'
          : failure.message
      }
      action={{
        label: retrying ? 'Checking…' : 'Retry',
        onClick: onRetry,
        disabled: retrying,
      }}
    />
  )
}
