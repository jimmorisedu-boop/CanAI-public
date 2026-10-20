import React from 'react'
import { InlineNotice } from './InlineNotice'

export function LocalRecoveryNotice({
  needsReview, onHelp, className,
}: {
  needsReview?: boolean
  onHelp?(): void
  className?: string
}) {
  if (!needsReview) return null
  return (
    <InlineNotice
      className={className}
      tone="warning"
      title="Recovered data needs review"
      detail="CanAI restored a backup. Some recent work may be missing. Media cleanup is paused to protect your files. Keep this app folder and review Tasks on the computer before retrying a generation."
      action={onHelp ? { label: 'Recovery help', onClick: onHelp } : undefined}
    />
  )
}
