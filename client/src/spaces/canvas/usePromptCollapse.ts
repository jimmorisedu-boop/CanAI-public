import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { hits } from '../../ui/hotkeys'

export function promptCollapseKey(event: KeyboardEvent, active: Element | null): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || !hits('prompt.collapse', event)) return false
  // composedPath учитывает редакторы внутри Shadow DOM; activeElement —
  // поле, которому принадлежит ввод при перенаправленном событии.
  return ![active, ...event.composedPath()].some(target => {
    const element = target as HTMLElement | null
    return element?.isContentEditable || element?.closest?.('input, textarea, select, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"]')
  })
}

export function usePromptCollapse(dock: RefObject<HTMLDivElement | null>) {
  const [collapsed, setCollapsed] = useState(false)
  const focusAfterToggle = useRef(false)
  const toggle = useCallback(() => {
    focusAfterToggle.current = true
    setCollapsed(value => !value)
  }, [])
  const expand = useCallback(() => setCollapsed(false), [])

  useEffect(() => {
    if (!focusAfterToggle.current) return
    focusAfterToggle.current = false
    dock.current?.querySelector<HTMLButtonElement>(collapsed ? '.prompt-dock-restore' : '.prompt-collapse-btn[aria-expanded]')?.focus({ preventScroll: true })
  }, [collapsed, dock])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!dock.current?.getClientRects().length || !promptCollapseKey(event, document.activeElement)) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"], .settings-backdrop')) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dock, toggle])

  return { collapsed, toggle, expand }
}
