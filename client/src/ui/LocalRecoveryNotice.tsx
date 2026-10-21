import React from 'react'
import { InlineNotice } from './InlineNotice'
import { useT } from '../i18n/context.js'

export function LocalRecoveryNotice({
  needsReview, onHelp, className,
}: {
  needsReview?: boolean
  onHelp?(): void
  className?: string
}) {
  const t = useT()
  if (!needsReview) return null
  return (
    <InlineNotice
      className={className}
      tone="warning"
      title={t('Recovered data needs review')}
      detail={t('CanAI restored a backup. Some recent work may be missing. Media cleanup is paused to protect your files. Keep this app folder and review Tasks on the computer before retrying a generation.')}
      action={onHelp ? { label: t('Recovery help'), onClick: onHelp } : undefined}
    />
  )
}
