import { useEffect, useRef, useState } from 'react'
import { api, isLocalServiceUnavailable, type TrashedProjectMeta } from '../api'
import { IconClose, IconRefresh, IconTrash } from '../ui/icons'
import { askConfirm } from '../ui/confirmBus'
import { useDialogFocus } from '../ui/dialogFocus'
import { InlineNotice } from '../ui/InlineNotice'
import { useT } from '../i18n/context.js'
import { getIntlLocale } from '../i18n/language.js'


interface TrashModalProps { onClose: () => void; onChanged: () => void; onRestored: (projectId: string) => void; onServiceUnavailable: () => void }

function TrashPreview({ project }: { project: TrashedProjectMeta }) {
  const [broken, setBroken] = useState(false)
  const preview = project.preview
  if (!preview || broken) return <div className="trash-thumb empty" aria-hidden="true" />
  if (preview.kind === 'video') return <video className="trash-thumb" src={preview.src} aria-hidden="true" muted playsInline preload="metadata" onError={() => setBroken(true)} />
  return <img className="trash-thumb" src={preview.src} alt="" loading="lazy" onError={() => setBroken(true)} />
}

export function TrashModal({ onClose, onChanged, onRestored, onServiceUnavailable }: TrashModalProps) {
  const t = useT()
  const countLabel = (count: number, singular: string, plural: string) => `${count} ${t(Math.abs(count) === 1 ? singular : plural)}`
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [projects, setProjects] = useState<TrashedProjectMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const load = async () => {
    try { setProjects((await api.listProjectTrash()).projects); setError(null) }
    catch (cause) {
      if (isLocalServiceUnavailable(cause)) { onServiceUnavailable(); onClose(); return }
      setError(cause instanceof Error ? cause.message : t('Could not open Trash'))
    }
  }
  useEffect(() => { void load() }, [])
  const restore = async (project: TrashedProjectMeta) => {
    if (busyId) return
    setBusyId(project.id); setError(null)
    try { await api.restoreTrashedProject(project.id); onRestored(project.id); onChanged(); await load() }
    catch (cause) {
      if (isLocalServiceUnavailable(cause)) { onServiceUnavailable(); onClose(); return }
      setError(cause instanceof Error ? cause.message : t('Could not restore board'))
    } finally { setBusyId(null) }
  }
  const emptyTrash = async () => {
    if (busyId || !projects?.length) return
    if (!await askConfirm({ title: t('Empty Trash: {0}?', { 0: countLabel(projects.length, 'board', 'boards') }), detail: t('All boards in Trash, along with their chats and backups, will be deleted. They cannot be restored.'), confirmLabel: t('Empty Trash'), cancelLabel: t('Keep as is'), danger: true })) return
    setBusyId('__all__'); setError(null)
    try { await api.emptyProjectTrash(); await load() }
    catch (cause) {
      if (isLocalServiceUnavailable(cause)) { onServiceUnavailable(); onClose(); return }
      setError(cause instanceof Error ? cause.message : t('Could not empty Trash'))
    } finally { setBusyId(null) }
  }
  const removePermanently = async (project: TrashedProjectMeta) => {
    if (busyId) return
    if (!await askConfirm({ title: t('Delete “{0}” permanently?', { 0: project.name }), detail: t('The board, its assistant chat, and backups will be deleted. They cannot be restored.'), confirmLabel: t('Delete permanently'), cancelLabel: t('Keep in Trash'), danger: true })) return
    setBusyId(project.id); setError(null)
    try { await api.deleteTrashedProject(project.id); await load() }
    catch (cause) {
      if (isLocalServiceUnavailable(cause)) { onServiceUnavailable(); onClose(); return }
      setError(cause instanceof Error ? cause.message : t('Could not delete board'))
    } finally { setBusyId(null) }
  }
  return <div className="modal-backdrop" onClick={onClose}><section ref={dialogRef} className="modal-card recovery-modal" role="dialog" aria-modal="true" aria-labelledby="trash-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
    <header><div className="trash-head-text"><h2 id="trash-title">{t('Trash')} {projects?.length ? <span className="trash-count">{countLabel(projects.length, 'board', 'boards')}</span> : null}</h2><p>{t('Restore boards along with their chats and backups.')}</p></div>{projects?.length ? <button type="button" className="trash-empty-all" disabled={busyId !== null} onClick={() => void emptyTrash()}><IconTrash size={14} />  {t('Empty')}</button> : null}<button className="icon-btn" type="button" aria-label={t('Close')} onClick={onClose}><IconClose /></button></header>
    {error && <InlineNotice className="recovery-error" tone="error" title={error} action={{ label: t('Retry'), onClick: () => void load() }} />}
    {projects === null ? <p>{t('Loading…')}</p> : projects.length === 0 ? <p>{t('Trash is empty.')}</p> : <div className="recovery-list">{projects.map((project) => <article key={project.id}><TrashPreview project={project} /><div><strong>{project.name}</strong><small>{project.itemCount === undefined ? null : project.itemCount === 0 ? t('Empty board · ') : `${countLabel(project.itemCount, 'object', 'objects')} · `}{t('Deleted {0}', { 0: new Date(project.trashedAt).toLocaleString(getIntlLocale()) })}</small></div><div className="trash-row-actions"><button type="button" className="trash-restore" disabled={busyId !== null} onClick={() => void restore(project)}><IconRefresh size={14} /> {busyId === project.id ? t('Working…') : t('Restore')}</button><button type="button" className="icon-btn trash-forget" aria-label={t('Delete “{0}” permanently', { 0: project.name })} title={t('Delete permanently')} disabled={busyId !== null} onClick={() => void removePermanently(project)}><IconTrash size={15} /></button></div></article>)}</div>}
  </section></div>
}
