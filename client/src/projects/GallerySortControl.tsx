import React, { useEffect, useId, useRef, useState } from 'react'
import { IconCaretDown, IconDone } from '../ui/icons'
import type { GallerySort } from './galleryProjectList'
import { moveGallerySort, SORT_OPTIONS, type GallerySortNavigationKey } from './gallerySortModel'
import { useT } from '../i18n/context.js'


export function GallerySortMenu({
  value,
  active,
  onSelect,
}: {
  value: GallerySort
  active: GallerySort
  onSelect(value: GallerySort): void
}) {
  const t = useT()
  return (
    <div className="gallery-sort-menu" role="listbox" aria-label={t('Board sorting')}>
      {SORT_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`gallery-sort-option${active === option.value ? ' is-active' : ''}`}
          role="option"
          aria-selected={value === option.value}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(option.value)}
        >
          <span>{t(option.label)}</span>
          {value === option.value && <IconDone size={16} aria-hidden="true" />}
        </button>
      ))}
    </div>
  )
}

export function GallerySortControl({
  value,
  onChange,
}: {
  value: GallerySort
  onChange(value: GallerySort): void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<GallerySort>(value)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const label = t(SORT_OPTIONS.find((option) => option.value === value)?.label ?? SORT_OPTIONS[0].label)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const openMenu = (nextActive = value) => {
    setActive(nextActive)
    setOpen(true)
  }

  const select = (next: GallerySort) => {
    onChange(next)
    setActive(next)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) select(active)
      else openMenu()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const key = event.key as GallerySortNavigationKey
    const next = moveGallerySort(open ? active : value, key)
    openMenu(next)
  }

  return (
    <div ref={rootRef} className={`gallery-sort${open ? ' is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="gallery-sort-trigger"
        aria-label={t('Board sorting')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={onKeyDown}
      >
        <span className="gallery-sort-label">{t('Sort')}</span>
        <strong>{label}</strong>
        <IconCaretDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId}>
          <GallerySortMenu value={value} active={active} onSelect={select} />
        </div>
      )}
    </div>
  )
}
