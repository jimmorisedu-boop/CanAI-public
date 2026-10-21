export type FalConnectionState = 'loading' | 'disconnected' | 'connected' | 'unverified'

export interface FalConnectionPresentation {
  label: string
  tone: 'neutral' | 'success' | 'warning'
}

const CONNECTION_PRESENTATIONS: Record<FalConnectionState, FalConnectionPresentation> = {
  loading: { label: t('Checking settings…'), tone: 'neutral' },
  disconnected: { label: t('Not connected'), tone: 'neutral' },
  connected: { label: t('Connected'), tone: 'success' },
  unverified: {
    label: t('Key saved, but the connection could not be checked'),
    tone: 'warning',
  },
}

export function falConnectionPresentation(state: FalConnectionState): FalConnectionPresentation {
  return CONNECTION_PRESENTATIONS[state]
}

export function editorDisplayName(editorPath: string): string {
  const trimmed = editorPath.trim()
  if (!trimmed) return t('No program selected')

  const filename = trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed
  return filename.replace(/\.(?:exe|app)$/i, '') || filename
}
import { t } from '../i18n/translate.js'
