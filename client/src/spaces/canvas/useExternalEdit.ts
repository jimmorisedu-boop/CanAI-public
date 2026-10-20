import { useState, useSyncExternalStore } from 'react'
import { api, ApiError } from '../../api'
import { openSettings } from '../../settings/settingsBus'
import type { ImageEditRequest } from './editorBus'
import { browserExternalEditRegistry } from './externalEditRegistry'

/**
 * External editor bridge for the local board.  The editor opens a file from
 * the local media directory; the Host owns the edit session and writes the
 * updated file back to the same local store.
 */
export function useExternalEdit(
  projectId: string,
  _projectSource: 'local' | 'cloud' = 'local',
  _projectName?: string,
) {
  const [notice, setNotice] = useState<string | null>(null)
  const snapshot = useSyncExternalStore(
    browserExternalEditRegistry.subscribe,
    browserExternalEditRegistry.getSnapshot,
    browserExternalEditRegistry.getSnapshot,
  )
  const sessions = snapshot.sessions.filter((session) => session.projectId === projectId)

  async function startEdit(request: ImageEditRequest): Promise<void> {
    setNotice(null)
    try {
      const session = await api.startEditSession({
        src: request.src,
        projectId,
        sourceItemId: request.shapeId,
        sourceName: request.name,
        boardSource: 'local',
      })
      browserExternalEditRegistry.track(session)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no_editor') {
        openSettings('Specify the program in which to open the pictures and repeat (F2).', 'editor')
      } else {
        setNotice(error instanceof Error ? error.message : 'Failed to open file in editor')
      }
    }
  }

  async function stopSession(id: string): Promise<void> {
    try {
      await browserExternalEditRegistry.stop(id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to stop tracking')
    }
  }

  return { sessions, notice, setNotice, startEdit, stopSession }
}
