import { systemMessage } from '../../ui/systemMessage'

export interface PersonalDraftState {
  enabled: boolean
  state: 'local-only' | 'dirty' | 'uploading' | 'synced' | 'error'
  requestId?: string
  checksum?: string
  snapshotRevision?: number
  remoteRevisionId?: string
  remoteDraftId?: string
  firstDirtyAt?: number
  lastChangedAt?: number
  error?: string
}

export type PersonalDraftTone = PersonalDraftState['state']

export function draftTone(state: PersonalDraftState): PersonalDraftTone {
  if (!state.enabled) return 'local-only'
  return state.state
}

export function draftLabel(state: PersonalDraftState): string {
  switch (draftTone(state)) {
    case 'local-only': return "Personal board is stored only on this computer"
    case 'dirty': return "The draft has been changed - shipping will be in one batch"
    case 'uploading': return "We send a personal draft to the server..."
    case 'synced': return "Personal draft saved on the server"
    case 'error': return systemMessage(state.error, 'Failed to submit personal draft')
  }
}
