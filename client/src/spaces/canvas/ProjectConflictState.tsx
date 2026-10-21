import React from 'react'
import { OperationState } from '../../ui/OperationState'
import type { ProjectConflictSnapshot } from './projectConflict'
import { useT } from '../../i18n/context.js'


interface ProjectConflictStateProps {
  phase: 'saving' | 'conflict'
  conflict: ProjectConflictSnapshot | null
  retrying: boolean
  /** Идёт уборка копии в корзину. */
  discarding?: boolean
  onOpenCopy(): void
  onUseServer(): void
  onRetry(): void
  /** Return an invalid local snapshot to the canvas for manual repair. */
  onRepair(): void
  /** Explicitly copy cloud asset bytes into local media when available. */
  onRestoreCloud?(): void
  canRestoreCloud?: boolean
  onDownload(): void
}

export function ProjectConflictState({
  phase,
  conflict,
  retrying,
  discarding = false,
  onOpenCopy,
  onUseServer,
  onRetry,
  onRepair,
  onRestoreCloud,
  canRestoreCloud = false,
  onDownload,
}: ProjectConflictStateProps) {
  const t = useT()
  if (phase === 'saving') {
    return (
      <OperationState
        tone="info"
        title={t('We save the changes from this tab...')}
        detail={t('We create a separate copy so that nothing is lost.')}
      />
    )
  }

  if (conflict?.status === 'saved' && conflict.recoveryProject) {
    return (
      <OperationState
        tone="success"
        title={t('Both versions saved')}
        // ⚠️ Прямо говорим, что станет с копией. Раньше вторая кнопка называлась
        // «Продолжить с последней версией» и просто перезагружала страницу —
        // копия оставалась в галерее навсегда, и человек, выбравший последнюю
        // версию, обнаруживал две доски (жалоба тестировщика 18.09.2026).
        detail={t('Changes from this tab are saved as "{0}". The original board remains with the changes from the other tab. The tab can be safely closed. If you don’t need a copy, remove it; it will go into the trash, where you can always return it.', { 0: conflict.recoveryProject.name })}
        action={{ label: "Open my copy", onClick: onOpenCopy }}
        secondary={{
          label: discarding ? "Let's remove..." : "Remove copy and continue",
          onClick: onUseServer,
          disabled: discarding,
        }}
      >
        <button onClick={onDownload}>{t('Download JSON')}</button>
      </OperationState>
    )
  }

  const canRetry = Boolean(conflict?.recoveryProject)
  if (conflict?.reason === 'invalid-snapshot') {
    return (
      <OperationState
        tone="warning"
        title={t('The latest changes have not been saved yet')}
        detail='The snapshot contains inaccessible media files or command board links. Download the JSON, return the original files and click "Retry"; or return to the board and delete the problematic object. Without the original files, complete recovery is impossible.'
        action={{
          label: retrying ? "Checking…" : "Retry",
          onClick: onRetry,
          disabled: retrying,
        }}
      >
        {conflict && <button onClick={onDownload}>{t('Download JSON')}</button>}
        {canRestoreCloud && onRestoreCloud && (
          <button onClick={onRestoreCloud}>{t('Restore from network board')}</button>
        )}
        <button onClick={onRepair}>{t('Return to the board and correct')}</button>
      </OperationState>
    )
  }
  return (
    <OperationState
      tone="warning"
      title={t('The latest changes have not been saved yet')}
      detail={canRetry
        ? t('A copy has been created, but the latest changes are still only in this tab. Do not close it until the retry is successful.')
        : t('The server did not acknowledge the conflicting copy. Download the JSON before closing the tab.')}
      action={canRetry ? {
        label: retrying ? "Saving…" : "Retry",
        onClick: onRetry,
        disabled: retrying,
      } : undefined}
    >
      {conflict && <button onClick={onDownload}>{t('Download JSON')}</button>}
    </OperationState>
  )
}
