import { OperationState } from '../ui/OperationState'
import type { GalleryFailure } from './galleryAvailability'
import { useT } from '../i18n/context.js'


export function GalleryFailureState({
  failure,
  retrying,
  onRetry,
}: {
  failure: Exclude<GalleryFailure, null>
  retrying: boolean
  onRetry: () => void
}) {
  const t = useT()
  const serviceUnavailable = failure.kind === 'service-unavailable'
  return (
    <OperationState
      title={serviceUnavailable ? t('CanAI is temporarily unavailable') : t('Could not load boards')}
      detail={
        serviceUnavailable
          ? t('Start CanAI again with “Start CanAI.bat”, then click “Retry”.')
          : failure.message
      }
      action={{
        label: retrying ? t('Checking…') : t('Retry'),
        onClick: onRetry,
        disabled: retrying,
      }}
    />
  )
}
