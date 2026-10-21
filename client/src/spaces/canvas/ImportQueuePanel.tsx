import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { IconClose, IconRefresh, IconStop } from '../../ui/icons'
import { cancelImport, dismissImport, getImports, retryImport, subscribeImports } from './importQueue'
import { systemErrorMessage } from '../../ui/systemMessage'
import { useT } from '../../i18n/context.js'


function bytes(value: number): string {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`
}

/**
 * Сколько места справа занимает полка ассетов — от её правого края до самой
 * левой плитки.
 *
 * ⚠️ Меряем ПЛИТКИ, а не саму полку: на низком окне слоты складываются в две
 * колонки, и вторая выходит ЗА рамку полки влево — ширина рамки при этом
 * остаётся в одну плитку. Число, угадывающее чужую раскладку, врёт молча:
 * медиа-запрос по высоте окна промахнулся на первом же замере (окно 730 —
 * две колонки, а порог стоял на 720).
 */
export function assetShelfWidth(shelf: Element | null | undefined): number | null {
  if (!shelf) return null
  const edge = shelf.getBoundingClientRect().right
  let left = edge
  for (const slot of shelf.querySelectorAll('.asset-slot')) left = Math.min(left, slot.getBoundingClientRect().left)
  return Math.max(0, Math.round(edge - left))
}

export function ImportQueuePanel() {
  const t = useT()
  const tasks = useSyncExternalStore(subscribeImports, getImports, getImports)
  const panel = useRef<HTMLElement>(null)
  const shown = tasks.length > 0

  // Панель встаёт СЛЕВА от полки ассетов (см. .import-queue): раньше обе
  // занимали правый верхний угол, и карточка загрузки закрывала слоты.
  useLayoutEffect(() => {
    const node = panel.current
    const shelf = node?.parentElement?.querySelector('.asset-bar')
    if (!node || !shelf) return
    const apply = (): void => {
      const width = assetShelfWidth(shelf)
      if (width != null && width > 0) node.style.setProperty('--asset-shelf-width', `${width}px`)
    }
    apply()
    // Высота окна меняет число колонок, закрепление ассета — число плиток.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null
    resized?.observe(shelf)
    const changed = typeof MutationObserver === 'function' ? new MutationObserver(apply) : null
    changed?.observe(shelf, { childList: true, subtree: true })
    return () => {
      resized?.disconnect()
      changed?.disconnect()
    }
  }, [shown])

  if (!shown) return null
  return (
    <aside className="import-queue" aria-label={t('File import')} ref={panel}>
      {tasks.map((task) => (
        <article key={task.id}>
          <div><strong title={task.name}>{task.name}</strong><small>{task.state === 'error'
            ? systemErrorMessage(task.error, 'Import failed')
            : t('{0} of {1}', { 0: bytes(task.loaded), 1: bytes(task.total) })}</small></div>
          {task.state === 'uploading' ? (
            <button className="icon-btn" aria-label={t('Stop import')} onClick={() => cancelImport(task.id)}><IconStop size={14} /></button>
          ) : (
            <>
              <button className="icon-btn" aria-label={t('Retry import')} onClick={() => retryImport(task.id)}><IconRefresh size={14} /></button>
              <button className="icon-btn" aria-label={t('Remove')} onClick={() => dismissImport(task.id)}><IconClose size={14} /></button>
            </>
          )}
          <progress max={task.total || 1} value={task.loaded} />
        </article>
      ))}
    </aside>
  )
}
