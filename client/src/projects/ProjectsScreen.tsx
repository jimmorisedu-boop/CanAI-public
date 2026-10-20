import React, { useEffect, useRef, useState } from 'react'
import { api, isLocalServiceUnavailable, type ProjectMeta } from '../api'
import { IconMenu, IconMoon, IconPin, IconPlus, IconSearch, IconSettings, IconSun, IconTrash, IconUpload } from '../ui/icons'
import { TrashModal } from './TrashModal'
import { VersionsModal } from './VersionsModal'
import { InlineNotice } from '../ui/InlineNotice'
import { LocalRecoveryNotice } from '../ui/LocalRecoveryNotice'
import { openHelp } from '../help/helpBus'
import { showErrorToast } from '../spaces/canvas/toastBus'
import { registerProjectTrashSink } from '../spaces/canvas/projectTrashBus'
import { visibleProjects, type GallerySort } from './galleryProjectList'
import { importCanaiProject } from './canaiImport'
import { GallerySortControl } from './GallerySortControl'
import { projectKey } from './projectRef'
import type { ProjectRef } from '../types'
import { onSettingsSaved } from '../settings/settingsBus'
import { isGalleryServiceUnavailable, type GalleryFailure } from './galleryAvailability'
import { GalleryFailureState } from './GalleryFailureState'
import { ProjectMenuAnchor } from './ProjectMenuAnchor'

function formatDate(ms: number): string {
  try { return new Date(ms).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }) } catch { return '' }
}
function boardUrl(ref: ProjectRef): string { return `?project=${encodeURIComponent(projectKey(ref))}` }
function openProjectInBackground(ref: ProjectRef): void {
  const win = window.open('about:blank', '_blank')
  if (win) { win.blur(); window.focus(); win.location.href = boardUrl(ref) }
}
function ProjectPreviewMedia({ preview }: { preview: ProjectMeta['preview'] }) {
  if (!preview) return <div className="project-thumb-empty" />
  if (preview.kind === 'video') return <video className="project-preview-media" src={preview.src} aria-hidden="true" muted playsInline preload="metadata" onLoadedData={(event) => event.currentTarget.classList.add('loaded')} onError={(event) => { event.currentTarget.style.display = 'none' }} />
  return <img className="project-preview-media" src={preview.src} alt="" loading="lazy" onLoad={(event) => event.currentTarget.classList.add('loaded')} onError={(event) => { event.currentTarget.style.display = 'none' }} />
}

export function ProjectsScreen({ onOpen, onSettings, theme, setTheme }: { onOpen: (ref: ProjectRef, project: ProjectMeta) => void; onSettings: () => void; theme: 'light' | 'dark' | 'system'; setTheme: (theme: 'light' | 'dark' | 'system') => void }) {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null)
  const [failure, setFailure] = useState<GalleryFailure>(null)
  const [recoveryNeedsReview, setRecoveryNeedsReview] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<GallerySort>('recent')
  const [busy, setBusy] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [trashOpen, setTrashOpen] = useState(false)
  const [versionsProject, setVersionsProject] = useState<ProjectMeta | null>(null)
  const [undoProject, setUndoProject] = useState<ProjectMeta | null>(null)
  const importRef = useRef<HTMLInputElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const reload = async () => {
    try { setProjects((await api.listProjects()).projects); setFailure(null) }
    catch (cause) { setFailure(isLocalServiceUnavailable(cause) ? { kind: 'service-unavailable' } : { kind: 'load-error', message: cause instanceof Error ? cause.message : 'Could not load boards' }) }
  }
  useEffect(() => { void reload() }, [])
  useEffect(() => onSettingsSaved(() => void reload()), [])
  useEffect(() => {
    let active = true
    const checkRecovery = () => {
      void api.status()
        .then((status) => {
          if (active) setRecoveryNeedsReview(status.recoveryNeedsReview === true)
        })
        .catch(() => {
          if (active) setRecoveryNeedsReview(false)
        })
    }
    checkRecovery()
    const stop = onSettingsSaved(checkRecovery)
    return () => {
      active = false
      stop()
    }
  }, [])
  useEffect(() => registerProjectTrashSink((_request) => { setTrashOpen(true); void reload() }), [])
  const list = projects ? visibleProjects(projects, query, sort) : []
  const serviceUnavailable = isGalleryServiceUnavailable(failure)
  const create = async () => {
    setBusy(true)
    try { const { project } = await api.createProject('Untitled'); onOpen({ source: 'local', id: project.id }, project) }
    catch (cause) { showErrorToast(cause instanceof Error ? cause.message : 'Could not create board') }
    finally { setBusy(false) }
  }
  const importProject = (file: File) => {
    setBusy(true)
    void importCanaiProject(file).then((project) => onOpen({ source: 'local', id: project.id }, project)).catch((cause) => showErrorToast(cause instanceof Error ? cause.message : 'Could not import project')).finally(() => setBusy(false))
  }
  const startRename = (project: ProjectMeta) => { setMenuId(null); setRenamingId(project.id); setRenameValue(project.name) }
  const commitRename = async (project: ProjectMeta) => {
    const name = renameValue.trim()
    if (!name || name === project.name) { setRenamingId(null); return }
    setBusy(true)
    try { const result = await api.renameProject(project.id, name); setProjects((current) => current?.map((item) => item.id === project.id ? result.project : item) ?? null); setRenamingId(null) }
    catch (cause) { showErrorToast(cause instanceof Error ? cause.message : 'Could not rename board') }
    finally { setBusy(false) }
  }
  const togglePin = async (project: ProjectMeta) => {
    setBusy(true)
    try { const result = await api.updateProject(project.id, { pinned: !project.pinned }); setProjects((current) => current?.map((item) => item.id === project.id ? result.project : item) ?? null) }
    catch (cause) { showErrorToast(cause instanceof Error ? cause.message : 'Could not update pin') }
    finally { setBusy(false); setMenuId(null) }
  }
  const remove = async (project: ProjectMeta) => {
    setBusy(true)
    try { await api.deleteProject(project.id); setProjects((current) => current?.filter((item) => item.id !== project.id) ?? null); setUndoProject(project) }
    catch (cause) { showErrorToast(cause instanceof Error ? cause.message : 'Could not move board to trash') }
    finally { setBusy(false); setMenuId(null) }
  }
  const undo = async () => {
    const project = undoProject
    if (!project) return
    setBusy(true)
    try { const result = await api.restoreTrashedProject(project.id); setProjects((current) => [result.project, ...(current ?? [])]); setUndoProject(null) }
    catch (cause) { showErrorToast(cause instanceof Error ? cause.message : 'Could not restore board') }
    finally { setBusy(false) }
  }
  return <div className="gallery-view">
    <header className="gallery-topbar"><span className="brand">CanAI</span><button type="button" className="tab settings-button icon-btn" title="Settings" aria-label="Settings" onClick={onSettings}><IconSettings size={18} aria-hidden="true" /></button><button type="button" className="tab icon-btn" title="Toggle theme" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}</button></header>
    <div className="gallery-scroll"><div className="gallery-inner"><h1 className="gallery-title">Your boards</h1><p className="gallery-subtitle">Pick up where you left off or start something new.</p>
      <LocalRecoveryNotice needsReview={recoveryNeedsReview} className="gallery-key-banner" onHelp={() => openHelp('recovery')} />
      {failure && <GalleryFailureState failure={failure} retrying={false} onRetry={() => void reload()} />}
      <div className="gallery-toolbar"><div className="gallery-toolbar-actions"><button type="button" className="gallery-new" disabled={busy || serviceUnavailable} onClick={() => void create()}><IconPlus size={18} weight="bold" /> New board</button><button type="button" className="gallery-import" disabled={busy || serviceUnavailable} onClick={() => importRef.current?.click()}><IconUpload size={17} /> Import</button><input ref={importRef} hidden type="file" accept=".canai,application/zip" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) importProject(file) }} /><button type="button" className="gallery-trash icon-tab" disabled={serviceUnavailable} onClick={() => setTrashOpen(true)}><IconTrash size={17} /> Trash</button><div className="gallery-search"><IconSearch className="gallery-search-icon" size={17} /><input ref={searchRef} className="gallery-search-input" value={query} placeholder="Search boards" aria-label="Search boards" onChange={(event) => setQuery(event.target.value)} /></div></div><div className="gallery-toolbar-filters"><GallerySortControl value={sort} onChange={setSort} /></div></div>
      {!projects && !failure && <div className="gallery-empty">Loading…</div>}{projects && list.length === 0 && <div className="gallery-empty">{query ? 'No boards match your search.' : 'No boards yet — create your first one.'}</div>}
      <div className="project-grid">{list.map((project) => <div className={`project-card ${menuId === project.id ? 'is-menu-open' : ''}`} key={project.id} onDoubleClick={() => onOpen({ source: 'local', id: project.id }, project)}><button type="button" className="project-card-open" aria-label={`Open board “${project.name}”`} onClick={() => onOpen({ source: 'local', id: project.id }, project)}><div className="project-thumb"><ProjectPreviewMedia preview={project.preview ?? null} /></div><div className="project-meta"><div className="project-name-row">{renamingId === project.id ? <input className="project-name-input" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void commitRename(project); if (event.key === 'Escape') setRenamingId(null) }} onBlur={() => void commitRename(project)} /> : <><div className="project-name" title={project.name}>{project.name}</div>{project.pinned && <span className="project-pin-marker is-pinned" role="img" aria-label="Pinned"><IconPin size={15} /></span>}</>}</div><div className="project-card-subline"><div className="project-date">{formatDate(project.updatedAt)}</div><span className="project-source-badge">Local</span></div></div></button><div className="project-card-actions"><ProjectMenuAnchor button={<button type="button" className="icon-btn project-menu-button" aria-label={`Actions for “${project.name}”`} aria-expanded={menuId === project.id} onClick={(event) => { event.stopPropagation(); setMenuId(menuId === project.id ? null : project.id) }}><IconMenu size={18} /></button>} menu={menuId === project.id ? <div className="project-menu" role="menu" onClick={(event) => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => openProjectInBackground({ source: 'local', id: project.id })}>Open in new tab</button><button type="button" role="menuitem" onClick={() => startRename(project)}>Rename</button><button type="button" role="menuitem" disabled={busy} onClick={() => void togglePin(project)}>{project.pinned ? 'Unpin' : 'Pin'}</button><button type="button" role="menuitem" onClick={() => { setVersionsProject(project); setMenuId(null) }}>Versions</button><button type="button" role="menuitem" className="danger" onClick={() => void remove(project)}>Move to Trash</button></div> : null} /></div></div>)}</div>
    </div></div>
    {undoProject && <div className="undo-toast" role="status">“{undoProject.name}” was moved to Trash.<button type="button" onClick={() => void undo()} disabled={busy}>Undo</button><button type="button" className="icon-btn" aria-label="Close" onClick={() => setUndoProject(null)}>×</button></div>}
    {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} onChanged={() => void reload()} onRestored={() => void reload()} onServiceUnavailable={() => setFailure({ kind: 'service-unavailable' })} />}
    {versionsProject && <VersionsModal project={versionsProject} onClose={() => setVersionsProject(null)} onRestored={(project) => { setProjects((current) => current?.map((item) => item.id === project.id ? project : item) ?? null); setVersionsProject(null) }} onServiceUnavailable={() => setFailure({ kind: 'service-unavailable' })} />}
  </div>
}

export function GallerySearchEmpty({ query, onReset }: { query: string; onReset: () => void }) { return <div className="gallery-search-empty" role="status"><h2>No results</h2><p>No boards match “{query}”.</p><button type="button" onClick={onReset}>Clear search</button></div> }
export function GalleryPinMarker({ pinned }: { pinned: boolean }) { return <span className={`project-pin-marker ${pinned ? 'is-pinned' : ''}`} role="img" aria-label={pinned ? 'Pinned' : 'Not pinned'}><IconPin size={15} /></span> }
