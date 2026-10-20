import React, { useEffect, useRef, useState } from 'react'
import { api, isLocalServiceUnavailable, type ProjectMeta, type ProjectVersion } from '../api'
import { IconClose, IconRefresh } from '../ui/icons'
import { useDialogFocus } from '../ui/dialogFocus'
import { InlineNotice } from '../ui/InlineNotice'
import { OBJECTS, pluralWithCount } from '../ui/plural'
import { reportOnboardingSuccess } from '../spaces/canvas/onboardingEvents'

export async function restoreProjectVersionWithOnboarding<T>(
  restore: () => Promise<T>,
  onRestored: (restored: T) => void,
): Promise<void> {
  const restored = await restore()
  reportOnboardingSuccess('recovery')
  onRestored(restored)
}

export async function loadVersionsForModal(
  projectId: string,
  load: (id: string) => Promise<{ versions: ProjectVersion[] }> = api.listProjectVersions,
): Promise<ProjectVersion[]> {
  return (await load(projectId)).versions
}

function versionParts(createdAt: number): { date: string; time: string } {
  const value = new Date(createdAt)
  return {
    date: value.toLocaleDateString('en-US'),
    time: value.toLocaleTimeString('en-US'),
  }
}

export function VersionsList({
  versions,
  busyId,
  onRestore,
}: {
  versions: ProjectVersion[]
  busyId: string | null
  onRestore(version: ProjectVersion): void
}) {
  return (
    <div className="recovery-list versions-list">
      {versions.map((version) => {
        const { date, time } = versionParts(version.createdAt)
        return (
          <article className="version-row" key={version.id}>
            <div className="version-thumb-slot">
              {version.preview && (
                <img
                  className="version-thumb"
                  src={version.preview}
                  alt=""
                  loading="lazy"
                  onError={(event) => { event.currentTarget.style.display = 'none' }}
                />
              )}
            </div>
            <div className="version-info">
              <strong className="version-date">{date}</strong>
              <span className="version-time">{time}</span>
              <small>
                {version.items == null
                  ? 'Contents unknown'
                  : version.items === 0
                    ? 'Empty board'
                    : pluralWithCount(version.items, OBJECTS)}
              </small>
            </div>
            <button className="version-action" disabled={busyId !== null} onClick={() => onRestore(version)}>
              <IconRefresh size={15} /> {busyId === version.id ? 'Restoring…' : 'Restore'}
            </button>
          </article>
        )
      })}
    </div>
  )
}

export function VersionsModal({ project, onClose, onRestored, onServiceUnavailable }: {
  project: ProjectMeta
  onClose: () => void
  onRestored: (project: ProjectMeta) => void
  onServiceUnavailable: () => void
}) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [versions, setVersions] = useState<ProjectVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const load = async () => {
    try {
      setVersions(await loadVersionsForModal(project.id))
      setError(null)
    } catch (cause) {
      if (isLocalServiceUnavailable(cause)) {
        onServiceUnavailable()
        onClose()
        return
      }
      setError(cause instanceof Error ? cause.message : 'Could not load versions')
    }
  }
  useEffect(() => { void load() }, [project.id])

  const restore = async (version: ProjectVersion) => {
    if (busyId) return
    setBusyId(version.id)
    setError(null)
    try {
      await restoreProjectVersionWithOnboarding(
        () => api.restoreProjectVersion(project.id, version.id),
        ({ project: restored }) => onRestored(restored),
      )
    } catch (cause) {
      if (isLocalServiceUnavailable(cause)) {
        onServiceUnavailable()
        onClose()
        return
      }
      setError(cause instanceof Error ? cause.message : 'Could not restore version')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section ref={dialogRef} className="modal-card recovery-modal versions-modal" role="dialog" aria-modal="true" aria-labelledby="versions-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <header>
          <div><h2 id="versions-title">Versions of “{project.name}”</h2><p>Restoring creates a new board and leaves the current one unchanged.</p></div>
          <button className="icon-btn" type="button" aria-label="Close" onClick={onClose}><IconClose /></button>
        </header>
        {error && (
          <InlineNotice
            className="recovery-error"
            tone="error"
            title={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        )}
        <div className="versions-modal-body">
          {versions === null ? <p>Loading…</p> : versions.length === 0 ? <p>No backups yet.</p> : (
            <VersionsList versions={versions} busyId={busyId} onRestore={(version) => void restore(version)} />
          )}
        </div>
      </section>
    </div>
  )
}
