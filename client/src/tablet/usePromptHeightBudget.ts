import { useLayoutEffect, useState, type RefObject } from 'react'

export function promptHeightBudget(bottom: number, top: number, scale: number, chrome: number) {
  return Math.max(44, (bottom - top - 8) / Math.max(.1, scale) - chrome)
}

/** Budget in unscaled CSS pixels, measured from the anchored bottom to the
 * visible board edge. Keep room for the actual header/references/options. */
export function usePromptHeightBudget(panel: RefObject<HTMLElement>, field: RefObject<HTMLElement>, area: RefObject<HTMLElement>, visibleHeight: number) {
  const [budget, setBudget] = useState({ panel: visibleHeight, field: visibleHeight - 180, area: visibleHeight - 60 })
  useLayoutEffect(() => {
    const node = panel.current
    const body = node?.closest('.tablet-body')
    if (!node || !body) return
    const measure = () => {
      const scale = Number(getComputedStyle(node).getPropertyValue('--tablet-panel-scale')) || 1
      const rect = node.getBoundingClientRect()
      const viewport = window.visualViewport
      const top = Math.max(body.getBoundingClientRect().top, viewport?.offsetTop ?? 0)
      const bottom = Math.min(rect.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight))
      const panelMax = promptHeightBudget(bottom, top, scale, 0)
      const fieldChrome = Math.max(0, node.offsetHeight - (field.current?.offsetHeight ?? 44))
      const areaChrome = Math.max(0, node.offsetHeight - (area.current?.offsetHeight ?? 0))
      const next = { panel: panelMax, field: Math.max(44, panelMax - fieldChrome), area: Math.max(180, panelMax - areaChrome) }
      setBudget(old => Object.keys(next).every(key => Math.abs(next[key as keyof typeof next] - old[key as keyof typeof old]) < 1) ? old : next)
    }
    const observer = new ResizeObserver(measure)
    for (const element of [node, body, field.current, area.current]) if (element) observer.observe(element)
    const placementObserver = new MutationObserver(measure)
    const dock = node.closest('.tablet-dock')
    if (dock) placementObserver.observe(dock, { attributes: true, attributeFilter: ['style', 'class'] })
    window.addEventListener('resize', measure)
    window.addEventListener('canai-tablet-ui-scale', measure)
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    measure()
    return () => {
      observer.disconnect()
      placementObserver.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('canai-tablet-ui-scale', measure)
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
    }
  }, [panel, field, area, visibleHeight])
  return budget
}
