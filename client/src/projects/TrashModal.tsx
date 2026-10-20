import { useEffect, useRef, useState } from 'react'
import { api, isLocalServiceUnavailable, type TrashedProjectMeta } from '../api'
import { IconClose, IconRefresh, IconTrash } from '../ui/icons'
import { askConfirm } from '../ui/confirmBus'
import { useDialogFocus } from '../ui/dialogFocus'
import { InlineNotice } from '../ui/InlineNotice'
import { BOARDS, OBJECTS, pluralWithCount } from '../ui/plural'

interface TrashModalProps { onClose: () => void; onChanged: () => void; onRestored: (projectId: string) => void; onServiceUnavailable: () => void }

function TrashPreview({ project }: { project: TrashedProjectMeta }) {
  const [broken, setBroken] = useState(false)
  const preview = project.preview
  if (!preview || broken) return <div className="trash-thumb empty" aria-hidden="true" />
  if (preview.kind === 'video') return <video className="trash-thumb" src={preview.src} aria-hidden="true" muted playsInline preload="metadata" onError={() => setBroken(true)} />
  return <img className="trash-thumb" src={preview.src} alt="" loading="lazy" onError={() => setBroken(true)} />
}

export function TrashModal({ onClose, onChanged, onRestored, onServiceUnavailable }: TrashModalProps) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [projects, setProjects] = useState<TrashedProjectMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const load = async () => {
    try { setProjects((await api.listProjectTrash()).projects); setError(null) }
    catch (cause) {
      if (isLocalServiceUnavailable(cause)) { onServiceUnavailable(); onClose(); return }
      setError(cause instanceof Error ? cause.message : 'Could not open Trash')
    }
  }
  useEffect(() => { void load() }, [])
  const restore = async (project: TrashedProjectMeta) => {
    if (busyId) return
    setBusyId(project.id); setError(null)
    try { await api.restoreTrashedProject(project.id); onRestored(project.id); onChanged(); await load() }
    catch (cause) {
      if (isLocalServiceUnavailable(cause)) { onServiceUnavailable(); onClose(); return }
      setError(cause instanceof Error ? cause.message : 'Could not restore board')
    } finally { setBusyId(null) }
  }
  const emptyTrash = async () => {
    if (busyId || !projects?.length) return
    if (!await askConfirm({ title: `Empty Trash: ${pluralWithCount(projects.length, BOARDS)}?`, detail: 'All boards in Trash, along with their chats and backups, will be deleted. They cannot be restored.', confirmLabel: 'Empty Trash', cancelLabel: 'Keep as is', danger: true })) return
    setBusyId('__all__'); setError(null)
    try { await api.emptyProjectTrash(); await load() }
    catch (cause) {
      if (isLocalServiceUnavailable(cause)) { onServiceUnavailable(); onClose(); return }
      setError(cause instanceof Error ? cause.message : 'Could not empty Trash')
    } finally { setBusyId(null) }
  }
  const removePermanently = async (project: TrashedProjectMeta) => {
    if (busyId) return
    if (!await askConfirm({ title: `Delete “${project.name}” permanently?`, detail: 'The board, its assistant chat, and backups will be deleted. They cannot be restored.', confirmLabel: 'Delete permanently', cancelLabel: 'Keep in Trash', danger: true })) return
    setBusyId(project.id); setError(null)
    try { await api.deleteTrashedProject(project.id); await load() }
    catch (cause) {
      if (isLocalServiceUnavailable(cause)) { onServiceUnavailable(); onClose(); return }
      setError(cause instanceof Error ? cause.message : 'Could not delete board')
    } finally { setBusyId(null) }
  }
  return <div className="modal-backdrop" onClick={onClose}><section ref={dialogRef} className="modal-card recovery-modal" role="dialog" aria-modal="true" aria-labelledby="trash-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
    <header><div className="trash-head-text"><h2 id="trash-title">Trash {projects?.length ? <span className="trash-count">{pluralWithCount(projects.length, BOARDS)}</span> : null}</h2><p>Restore boards along with their chats and backups.</p></div>{projects?.length ? <button type="button" className="trash-empty-all" disabled={busyId !== null} onClick={() => void emptyTrash()}><IconTrash size={14} /> Empty</button> : null}<button className="icon-btn" type="button" aria-label="Close" onClick={onClose}><IconClose /></button></header>
    {error && <InlineNotice className="recovery-error" tone="error" title={error} action={{ label: 'Retry', onClick: () => void load() }} />}
    {projects === null ? <p>Loading…</p> : projects.length === 0 ? <p>Trash is empty.</p> : <div className="recovery-list">{projects.map((project) => <article key={project.id}><TrashPreview project={project} /><div><strong>{project.name}</strong><small>{project.itemCount === undefined ? null : project.itemCount === 0 ? 'Empty board · ' : `${pluralWithCount(project.itemCount, OBJECTS)} · `}Deleted {new Date(project.trashedAt).toLocaleString('en-US')}</small></div><div className="trash-row-actions"><button type="button" className="trash-restore" disabled={busyId !== null} onClick={() => void restore(project)}><IconRefresh size={14} /> {busyId === project.id ? 'Working…' : 'Restore'}</button><button type="button" className="icon-btn trash-forget" aria-label={`Delete “${project.name}” permanently`} title="Delete permanently" disabled={busyId !== null} onClick={() => void removePermanently(project)}><IconTrash size={15} /></button></div></article>)}</div>}
  </section></div>
}
