import { useEffect, useMemo, useState } from 'react'
import { InlineNotice } from '../ui/InlineNotice'
import { LocalRecoveryNotice } from '../ui/LocalRecoveryNotice'
import { api } from '../api'
import { IconPlus, IconSearch, IconSettings, IconTrash } from '../ui/icons'
import type { BoardHolder } from '../types'
import { notify } from '../spaces/canvas/notifications'
import { previewSrc } from './remoteSession'
import { TabletDialog } from './TabletDialog'
import { TabletPopover, useAnchor } from './TabletPopover'
import { TabletSettings } from './TabletSettings'
import type { TabletProject, TabletRuntime } from './runtime'
import { TabletProjectTrash } from './TabletProjectTrash'
import { tabletSystemMessage } from './tabletSystemMessage'

type Board = TabletProject

/** Gallery for boards hosted by this local CanAI instance. */
export function TabletGallery({
  runtime,
  canCreate,
  onOpen,
}: {
  runtime: TabletRuntime
  canCreate: boolean
  onOpen(board: TabletProject): void
}) {
  const [boards, setBoards] = useState<Board[]>([])
  const [holders, setHolders] = useState<Record<string, BoardHolder>>({})
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<Board | null>(null)
  const [renaming, setRenaming] = useState<Board | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [recoveryNeedsReview, setRecoveryNeedsReview] = useState(false)
  const menu = useAnchor()
  const canRestore = Boolean(runtime.listArchivedProjects && runtime.restoreProject)

  const load = async () => {
    try {
      const [list, presence, status] = await Promise.all([
        runtime.listProjects(),
        runtime.boardPresence ? runtime.boardPresence().catch(() => []) : Promise.resolve([]),
        api.status().catch(() => null),
      ])
      setBoards(list)
      setRecoveryNeedsReview(status?.recoveryNeedsReview === true)
      setHolders(Object.fromEntries(presence.map((entry) => [entry.projectId, entry.holder])))
      setError(null)
    } catch (cause) {
      setError(tabletSystemMessage(cause, 'Could not load boards'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(timer)
  }, [runtime])

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return words.length === 0 ? boards : boards.filter((board) => words.every((word) => board.name.toLowerCase().includes(word)))
  }, [boards, query])

  return (
    <div className="tablet-screen tablet-gallery">
      <header className="tablet-topbar tablet-toolbar">
        <h1 className="tablet-screen-title">Your boards</h1>
        <span className="tablet-topbar-gap" />
        <label className="tablet-search">
          <IconSearch size={16} />
          <input className="ui-field" value={query} placeholder="Search" aria-label="Search boards" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="tablet-topbar-actions">
          {canRestore && <button type="button" className="ui-icon-btn tablet-icon" aria-label="Board trash" onClick={() => setTrashOpen(true)}><IconTrash size={20} /></button>}
          {canCreate && runtime.createProject && <button type="button" className="ui-btn primary" disabled={creating} onClick={async () => {
            setCreating(true)
            try { onOpen(await runtime.createProject!('New board')) }
            catch (cause) { setError(tabletSystemMessage(cause, 'Could not create board')) }
            finally { setCreating(false) }
          }}><IconPlus size={18} /> New board</button>}
          <button type="button" className="ui-icon-btn tablet-icon" aria-label="Settings" onClick={() => setSettingsOpen(true)}><IconSettings size={20} /></button>
        </div>
      </header>

      <LocalRecoveryNotice needsReview={recoveryNeedsReview} className="tablet-error" />
      {error && <InlineNotice className="tablet-error" tone="error" title={tabletSystemMessage(error, 'Could not load boards')} onDismiss={() => setError(null)} />}
      <div className="tablet-cards">
        {shown.map((board) => {
          const holder = holders[board.id]
          return <div className="tablet-card-wrap" key={board.id}>
            <button type="button" className="tablet-card" onClick={() => onOpen(board)}>
              <span className="tablet-card-thumb">{board.thumb ? <img src={previewSrc(board.thumb, 512)} alt="" decoding="async" /> : <span className="tablet-card-empty" />}</span>
              <span className="tablet-card-name">{board.name}</span>
              {holder && <span className="tablet-card-holder">open on “{holder.device}”</span>}
            </button>
            {board.permissions.canManage && <button type="button" className="tablet-card-more ui-icon-btn" aria-label={`What to do with board “${board.name}”`} onClick={(event) => { setMenuFor(board); menu.open(event) }}><span className="tablet-more-dots" aria-hidden="true">•••</span></button>}
          </div>
        })}
      </div>
      {loading && <p className="tablet-state" role="status">Loading boards…</p>}
      {!loading && shown.length === 0 && !error && <p className="tablet-state">{boards.length === 0 ? 'No boards yet.' : 'Nothing found.'}</p>}

      {menu.anchor && menuFor && <TabletPopover anchor={menu.anchor} label="Board actions" onClose={menu.close}>
        {runtime.renameProject && <button type="button" className="tablet-menu-item" onClick={() => { setRenaming(menuFor); menu.close() }}>Rename</button>}
        {runtime.archiveProject && <button type="button" className="tablet-menu-item danger" onClick={() => {
          const board = menuFor
          menu.close()
          void runtime.archiveProject?.(board.id).then(() => { notify({ kind: 'success', message: `“${board.name}” in trash`, ...(canRestore ? { action: { label: 'Open trash', run: () => setTrashOpen(true) } } : {}) }); void load() }).catch((cause) => notify({ kind: 'error', message: tabletSystemMessage(cause, 'Could not delete') }))
        }}>Move to trash</button>}
      </TabletPopover>}

      {renaming && <RenameBoard board={renaming} runtime={runtime} onClose={() => setRenaming(null)} onSaved={() => { setRenaming(null); void load() }} />}
      {settingsOpen && <TabletSettings onClose={() => setSettingsOpen(false)} />}
      {trashOpen && <TabletProjectTrash runtime={runtime} onClose={() => setTrashOpen(false)} onRestored={(project) => { setBoards((current) => [project, ...current.filter((item) => item.id !== project.id)]); notify({ kind: 'success', message: `Board “${project.name}” restored` }) }} />}
    </div>
  )
}

function RenameBoard({ board, runtime, onClose, onSaved }: { board: Board; runtime: TabletRuntime; onClose(): void; onSaved(): void }) {
  const [value, setValue] = useState(board.name)
  const trimmed = value.trim()
  return <TabletDialog title="Board name" onClose={onClose} actions={<>
    <button type="button" className="ui-btn quiet" onClick={onClose}>Cancel</button>
    <button type="button" className="ui-btn primary" disabled={!trimmed || trimmed === board.name} onClick={() => { if (!runtime.renameProject) return; void runtime.renameProject(board.id, trimmed).then(onSaved).catch((cause) => notify({ kind: 'error', message: tabletSystemMessage(cause, 'Could not rename') })) }}>Save</button>
  </>}>
    <input className="ui-field tablet-input-line" value={value} aria-label="Board name" autoFocus onChange={(event) => setValue(event.target.value)} />
  </TabletDialog>
}
