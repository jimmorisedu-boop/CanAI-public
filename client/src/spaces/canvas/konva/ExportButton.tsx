import React, { useEffect, useId, useRef, useState } from 'react'
import { IconExport } from '../../../ui/icons'
import { showErrorToast, showToast } from '../toastBus'
import type { CanvasItem } from './types'
import { downloadMarkedAsZip } from './zipExport'
import { groupsFromLegacyItems } from '../exportGroups'
import { createExportTarget, registerExportOnboardingTarget, showOnboardingTarget } from '../onboardingTargets'
import type { ProjectRef } from '../../../types'

// Кнопка в правом верхнем углу канваса: собирает ВСЕ помеченные цифрой
// объекты доски (не только выделенные — метки живут на самих объектах) в
// один zip с папкой на каждый номер метки. Скачивание неактивно, пока меток нет.
export function ExportButton({ items, project }: { items: CanvasItem[]; project: ProjectRef }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const tooltipId = useId()
  const markedCount = items.filter((i) => i.mark != null).length
  const groups = groupsFromLegacyItems(items)

  useEffect(() => registerExportOnboardingTarget(createExportTarget({
    focus: () => buttonRef.current?.focus({ preventScroll: true }),
    pulse: () => showOnboardingTarget(buttonRef.current, {
      message: 'Build a ZIP archive from the marked objects here.',
    }),
  })), [])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function run(): Promise<void> {
    if (busy || markedCount === 0) return
    setBusy(true)
    try {
      const { ok, failed, groups } = await downloadMarkedAsZip(items, project)
      if (ok === 0) showErrorToast('No files available for export')
      else if (failed > 0) showToast(`Exported ${ok}of ${ok + failed} to ${groups} folders — some files are unavailable`)
    } catch {
      showErrorToast('Failed to build export')
    } finally {
      setBusy(false)
    }
  }

  return (
    // Кнопка только иконкой: подпись «Экспорт» живёт в aria-label. Родного
    // title здесь быть НЕ должно — рядом своя подсказка про горячие клавиши,
    // и две всплывашки на одном наведении спорили бы друг с другом.
    <div className="export-control" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="tab canvas-export-btn icon-btn"
        aria-label="Group export"
        aria-describedby={open ? undefined : tooltipId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconExport size={16} />
      </button>
      {!open && (
        <div id={tooltipId} className="export-hotkey-tooltip" role="tooltip">
          <strong>Export groups</strong>
          <span>
            Select objects and enter a number from 1–999. Matching numbers go
            into one ZIP folder. 0 removes the label.
          </span>
        </div>
      )}
      {open && (
        <section className="export-panel" aria-label="Export groups">
          <header><strong>Export groups</strong><small>{markedCount} objects</small></header>
          {groups.length === 0 ? (
            <p>Select objects and enter a group number. Each group becomes a separate ZIP folder.</p>
          ) : (
            <div className="export-group-list">
              {groups.map((group) => (
                <div key={group.id} className="export-group-row">
                  <span>{group.name}</span><small>{group.itemIds.length}</small>
                </div>
              ))}
            </div>
          )}
          <div className="export-panel-actions">
            <button disabled={busy || !markedCount} onClick={() => void run()}>
              <IconExport size={14} /> Download ZIP
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
