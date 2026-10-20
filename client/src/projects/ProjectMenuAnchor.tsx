import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { positionProjectMenu } from './projectMenuPosition'

const useMenuLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** The portal keeps card transforms and gallery overflow from clipping the menu. */
export function ProjectMenuAnchor({ button, menu }: { button: React.ReactNode; menu?: React.ReactNode }) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const open = Boolean(menu)

  useMenuLayoutEffect(() => {
    const anchor = anchorRef.current
    const layer = layerRef.current
    const content = layer?.firstElementChild as HTMLElement | null
    if (!open || !anchor || !layer || !content) return
    const update = () => {
      const viewport = window.visualViewport
      const visible = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight }
      const rect = anchor.getBoundingClientRect()
      const position = positionProjectMenu(rect, {
        width: content.offsetWidth, height: content.scrollHeight + content.offsetHeight - content.clientHeight,
      }, visible)
      layer.style.left = `${position.left}px`
      layer.style.top = `${position.top}px`
      layer.style.maxWidth = `${position.maxWidth}px`
      layer.style.maxHeight = `${position.maxHeight}px`
      content.style.transformOrigin = position.opensUp ? 'bottom right' : 'top right'
      layer.style.visibility = rect.bottom > visible.top && rect.top < visible.top + visible.height ? 'visible' : 'hidden'
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(anchor)
    observer.observe(content)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open])

  return (
    <div className="project-menu-wrap" ref={anchorRef}>
      {button}
      {open && typeof document !== 'undefined' && createPortal(
        <div className="project-menu-positioner" ref={layerRef} style={{ visibility: 'hidden' }}>{menu}</div>,
        document.body,
      )}
    </div>
  )
}
