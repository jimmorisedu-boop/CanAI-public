import { useCallback, useEffect, useState } from 'react'
import { InlineNotice } from '../ui/InlineNotice'
import { IconRestore } from '../ui/icons'
import { TabletFullScreen } from './TabletFullScreen'
import type { TabletProject, TabletRuntime } from './runtime'
import { tabletSystemMessage } from './tabletSystemMessage'
import { useT } from '../i18n/context.js'


/** Восстановление доступно прямо из галереи и использует её же runtime. */
export function TabletProjectTrash({ runtime, onClose, onRestored }: {
  runtime: TabletRuntime
  onClose(): void
  onRestored(project: TabletProject): void
}) {
  const t = useT()
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
      if (active) setError(tabletSystemMessage(cause, t('Could not load trash')))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [runtime, reload, t])

  const restore = useCallback(async (project: TabletProject) => {
    if (restoring || !runtime.restoreProject || !project.permissions.canManage) return
    setRestoring(project.id)
    setError(null)
    try {
      const restored = await runtime.restoreProject(project.id)
      setBoards((current) => current.filter((item) => item.id !== project.id))
      onRestored(restored)
    } catch (cause) {
      setError(tabletSystemMessage(cause, t('Could not restore board')))
    } finally {
      setRestoring(null)
    }
  }, [runtime, restoring, onRestored, t])

  return <TabletFullScreen title={t('Board trash')} cancelLabel={t('Done')} onCancel={onClose}>
    <div className="tablet-project-trash">
      {loading && <p className="tablet-state" role="status">{t('Loading trash…')}</p>}
      {error && <InlineNotice tone="error" title={tabletSystemMessage(error, t('Could not load trash'))}
        action={{ label: t('Refresh'), onClick: () => setReload((value) => value + 1) }} />}
      {!loading && !error && boards.length === 0 && <p className="tablet-state" role="status">{t('Trash is empty.')}</p>}
      <ul className="tablet-trash-list" aria-label={t('Boards in trash')}>
        {boards.map((project) => <li className="tablet-trash-row" key={project.id}>
          <div className="tablet-trash-name">
            <strong>{project.name}</strong>
            {!project.permissions.canManage && <span>{t('Only the board creator or team lead can restore it.')}</span>}
          </div>
          <button type="button" className="ui-btn" disabled={Boolean(restoring) || !project.permissions.canManage}
                    aria-label={t('Restore board “{0}”', { 0: project.name })} onClick={() => void restore(project)}>
            <IconRestore size={18} />{restoring === project.id ? t('Restoring…') : t('Restore')}
          </button>
        </li>)}
      </ul>
    </div>
  </TabletFullScreen>
}
