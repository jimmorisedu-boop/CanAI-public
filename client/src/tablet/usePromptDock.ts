import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from 'react'

type Placement = { x: number; y: number; width: number; bottom?: number }
const KEY = 'canai-tablet-prompt-placement'
export function clampPromptDock(value: Placement, bounds: { width: number; height: number }, height: number, scale = 1): Placement {
  const width = Math.min(Math.max(320, value.width), Math.max(0, bounds.width - 24) / scale)
  const y = value.bottom === undefined ? value.y : bounds.height - value.bottom - height
  return { width, x: Math.max(12, Math.min(value.x, bounds.width - width * scale - 12)), y: Math.max(8, Math.min(y, bounds.height - height - 8)), ...(value.bottom === undefined ? {} : { bottom: Math.max(8, Math.min(value.bottom, bounds.height - height - 8)) }) }
}

/** Device preference only; neither moving nor resizing writes to the board. */
export function usePromptDock(dock: RefObject<HTMLDivElement>, body: RefObject<HTMLDivElement>, bottomInset: number, active: boolean) {
  const [placement, setPlacement] = useState<Placement | null>(() => {
    try {
      const value = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Placement | null
      return value && [value.x, value.y, value.width].every(Number.isFinite) ? value : null
    } catch { return null }
  })
  const [measured, setMeasured] = useState({ width: 1024, height: 768, dockHeight: 0, scale: 1 })
  const gesture = useRef<{ pointerId: number; x: number; y: number; start: Placement; resize: boolean } | null>(null)
  const latest = useRef(placement)
  latest.current = placement
  useEffect(() => {
    const bodyNode = body.current
    const dockNode = dock.current
    if (!active || !bodyNode || !dockNode) return
    const measure = () => {
      const scale = Number(getComputedStyle(dockNode).getPropertyValue('--tablet-panel-scale')) || 1
      const next = { width: bodyNode.clientWidth, height: bodyNode.clientHeight, dockHeight: dockNode.getBoundingClientRect().height, scale }
      setPlacement((old) => old && old.bottom === undefined && next.dockHeight > 0
        ? { ...old, bottom: Math.max(8, next.height - bottomInset - old.y - next.dockHeight) }
        : old)
      setMeasured((old) => old.width === next.width && old.height === next.height && old.dockHeight === next.dockHeight && old.scale === next.scale ? old : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(bodyNode); observer.observe(dockNode)
    const onScale = () => { gesture.current = null; measure() }
    window.addEventListener('canai-tablet-ui-scale', onScale)
    measure()
    return () => { observer.disconnect(); window.removeEventListener('canai-tablet-ui-scale', onScale) }
  }, [dock, body, active, bottomInset])
  const bounds = { width: measured.width, height: measured.height - bottomInset }
  const fitted = placement ? clampPromptDock(placement, bounds, measured.dockHeight, measured.scale) : null
  const save = () => {
    try { window.localStorage.setItem(KEY, JSON.stringify(latest.current)) } catch { /* optional preference */ }
  }
  const start = (event: PointerEvent<HTMLButtonElement>, resize: boolean) => {
    if (event.button !== 0 || !event.isPrimary || !dock.current || !body.current) return
    event.preventDefault()
    const rect = dock.current.getBoundingClientRect(), parent = body.current.getBoundingClientRect()
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: { x: rect.left - parent.left, y: rect.top - parent.top, width: rect.width / measured.scale, bottom: bounds.height - (rect.bottom - parent.top) }, resize }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.x, dy = event.clientY - current.y
    const value = clampPromptDock({ x: current.start.x + (current.resize ? 0 : dx), y: current.start.y + (current.resize ? 0 : dy), bottom: current.start.bottom! - (current.resize ? 0 : dy), width: current.start.width + (current.resize ? dx / measured.scale : 0) }, bounds, measured.dockHeight, measured.scale)
    latest.current = value
    setPlacement(value)
  }
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return
    move(event)
    gesture.current = null
    save()
  }
  const reset = () => { latest.current = null; setPlacement(null); save() }
  return {
    style: fitted ? { left: fitted.x, top: 'auto', bottom: (fitted.bottom ?? bounds.height - fitted.y - measured.dockHeight) + bottomInset, width: fitted.width, transform: 'scale(var(--tablet-panel-scale, 1))', transformOrigin: 'bottom left', transition: 'none' } as CSSProperties : {},
    drag: { onPointerDown: (event: PointerEvent<HTMLButtonElement>) => start(event, false), onPointerMove: move, onPointerUp: finish, onPointerCancel: () => { gesture.current = null } },
    resize: { onPointerDown: (event: PointerEvent<HTMLButtonElement>) => start(event, true), onPointerMove: move, onPointerUp: finish, onPointerCancel: () => { gesture.current = null } },
    reset,
    adjustWidth: (delta: number) => {
      if (!dock.current || !body.current) return
      const rect = dock.current.getBoundingClientRect(), parent = body.current.getBoundingClientRect()
      latest.current = clampPromptDock({ x: rect.left - parent.left, y: rect.top - parent.top, bottom: bounds.height - (rect.bottom - parent.top), width: (rect.width + delta) / measured.scale }, bounds, measured.dockHeight, measured.scale)
      setPlacement(latest.current); save()
    },
  }
}
