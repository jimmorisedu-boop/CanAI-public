import { useCallback, useEffect, useState } from 'react'
import { InlineNotice } from '../ui/InlineNotice'
import { IconRestore } from '../ui/icons'
import { TabletFullScreen } from './TabletFullScreen'
import type { TabletProject, TabletRuntime } from './runtime'
import { tabletSystemMessage } from './tabletSystemMessage'

/** Восстановление доступно прямо из галереи и использует её же runtime. */
export function TabletProjectTrash({ runtime, onClose, onRestored }: {
  runtime: TabletRuntime
  onClose(): void
  onRestored(project: TabletProject): void
}) {
  const [boards, setBoards] = useState<TabletProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void runtime.listArchivedProjects?.().then((projects) => {
      if (active) setBoards(projects)
    }).catch((cause: unknown) => {
      if (active) setError(tabletSystemMessage(cause, 'Could not load trash'))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [runtime, reload])

  const restore = useCallback(async (project: TabletProject) => {
    if (restoring || !runtime.restoreProject || !project.permissions.canManage) return
    setRestoring(project.id)
    setError(null)
    try {
      const restored = await runtime.restoreProject(project.id)
      setBoards((current) => current.filter((item) => item.id !== project.id))
      onRestored(restored)
    } catch (cause) {
      setError(tabletSystemMessage(cause, 'Could not restore board'))
    } finally {
      setRestoring(null)
    }
  }, [runtime, restoring, onRestored])

  return <TabletFullScreen title="Board trash" cancelLabel="Done" onCancel={onClose}>
    <div className="tablet-project-trash">
      {loading && <p className="tablet-state" role="status">Loading trash…</p>}
      {error && <InlineNotice tone="error" title={tabletSystemMessage(error, 'Could not load trash')}
        action={{ label: 'Refresh', onClick: () => setReload((value) => value + 1) }} />}
      {!loading && !error && boards.length === 0 && <p className="tablet-state" role="status">Trash is empty.</p>}
      <ul className="tablet-trash-list" aria-label="Boards in trash">
        {boards.map((project) => <li className="tablet-trash-row" key={project.id}>
          <div className="tablet-trash-name">
            <strong>{project.name}</strong>
            {!project.permissions.canManage && <span>Only the board creator or team lead can restore it.</span>}
          </div>
          <button type="button" className="ui-btn" disabled={Boolean(restoring) || !project.permissions.canManage}
                    aria-label={`Restore board “${project.name}”`} onClick={() => void restore(project)}>
            <IconRestore size={18} />{restoring === project.id ? 'Restoring…' : 'Restore'}
          </button>
        </li>)}
      </ul>
    </div>
  </TabletFullScreen>
}
