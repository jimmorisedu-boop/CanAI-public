import { useEffect, useState } from 'react'
import { agentPanelBottomReserve, agentPanelCompactPosition } from './agentPanelPresentation'

export const AGENT_PANEL_HEADER_MIN_HEIGHT = 48

export interface AgentPanelLayout {
  bottomReserve: number
  availableHeight: number
  compactPosition: { left: number; top: number } | null
}

export function agentPanelHasHeaderRoom(availableHeight: number): boolean {
  return availableHeight >= AGENT_PANEL_HEADER_MIN_HEIGHT
}

export function useAgentPanelLayout(enabled: boolean): AgentPanelLayout | null {
  const [layout, setLayout] = useState<AgentPanelLayout | null>(null)

  useEffect(() => {
    if (!enabled) return
    const mutationRoot = document.querySelector<HTMLElement>('.canvas-main')
    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null
    let observedDock: HTMLElement | null = null
    let observedCanvas: HTMLElement | null = null
    let observedAssetBar: HTMLElement | null = null
    let observedCorner: HTMLElement | null = null
    const update = () => {
      const dock = document.querySelector<HTMLElement>('.prompt-dock')
      const canvas = dock?.closest<HTMLElement>('.canvas-main')
      if (!dock || !canvas) {
        setLayout((current) => current === null ? current : null)
        return
      }
      if (resizeObserver && dock !== observedDock) {
        resizeObserver.observe(dock)
        observedDock = dock
      }
      if (resizeObserver && canvas !== observedCanvas) {
        resizeObserver.observe(canvas)
        observedCanvas = canvas
      }
      const assetBar = canvas.querySelector<HTMLElement>('.asset-bar')
      if (resizeObserver && assetBar !== observedAssetBar) {
        if (observedAssetBar) resizeObserver.unobserve(observedAssetBar)
        if (assetBar) resizeObserver.observe(assetBar)
        observedAssetBar = assetBar
      }
      const corner = canvas.querySelector<HTMLElement>('.canvas-corner')
      if (resizeObserver && corner !== observedCorner) {
        if (observedCorner) resizeObserver.unobserve(observedCorner)
        if (corner) resizeObserver.observe(corner)
        observedCorner = corner
      }
      const canvasRect = canvas.getBoundingClientRect()
      const dockRect = dock.getBoundingClientRect()
      const bottomReserve = agentPanelBottomReserve(
        canvasRect.bottom,
        dockRect.top,
      )
      const blockers = [dock, assetBar, corner]
        .filter((element): element is HTMLElement => Boolean(element))
        .map((element) => element.getBoundingClientRect())
      const next = {
        bottomReserve,
        // `.agent-panel` is pinned 16px from the top and reserves 16px of
        // breathing room above the dock. Keep this calculation in the same
        // coordinate system as its max-height, so a tall dock cannot reduce
        // the panel to an invisible sliver.
        availableHeight: Math.max(0, canvasRect.height - 32 - bottomReserve),
        compactPosition: agentPanelCompactPosition(canvasRect, blockers),
      }
      setLayout((current) => current
        && current.bottomReserve === next.bottomReserve
        && current.availableHeight === next.availableHeight
        && current.compactPosition?.left === next.compactPosition?.left
        && current.compactPosition?.top === next.compactPosition?.top
        ? current
        : next)
    }
    resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    mutationObserver = typeof MutationObserver === 'function' && mutationRoot
      ? new MutationObserver(update)
      : null
    update()
    if (mutationObserver && mutationRoot) {
      mutationObserver.observe(mutationRoot, { childList: true, subtree: true })
    }
    window.addEventListener('resize', update)
    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [enabled])

  return layout
}

export function useAgentPanelBottomReserve(enabled: boolean): number | null {
  return useAgentPanelLayout(enabled)?.bottomReserve ?? null
}
