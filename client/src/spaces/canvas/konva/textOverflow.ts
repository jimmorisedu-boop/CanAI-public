export interface TextFrameInput {
  text?: string
  w: number
  h: number
  fontSize: number
}

export function textOverflowsFrame(input: TextFrameInput): boolean {
  if (!input.text?.trim()) return false
  const required = computeAdaptiveTextDimensions(input.text, input.fontSize, input.w)
  return required.h > input.h + 0.5
}

export function overflowCueGeometry(input: Omit<TextFrameInput, 'text'>) {
  const compact = Math.min(input.w, input.h) < 48
  const inset = compact ? 6 : 8
  const badgeSize = Math.max(12, Math.min(28, input.w - inset * 2, input.h - inset * 2))
  const badgeX = Math.max(inset, input.w - inset - badgeSize)
  const badgeY = Math.max(inset, input.h - inset - badgeSize)
  const fadeH = Math.round(Math.min(input.h, Math.max(36, Math.min(64, input.fontSize * 1.7))))
  const chevronSize = Math.round(Math.max(8, Math.min(12, badgeSize * 0.42)))
  return {
    fadeY: input.h - fadeH,
    fadeH,
    badgeX,
    badgeY,
    badgeSize,
    chevronX: badgeX + (badgeSize - chevronSize) / 2,
    chevronY: badgeY + (badgeSize - chevronSize / 2) / 2,
    chevronSize,
  }
}

export function overflowCueTone(input: {
  overflowing: boolean
  selected: boolean
  hovered: boolean
}): 'hidden' | 'muted' | 'accent' {
  if (!input.overflowing) return 'hidden'
  return input.selected || input.hovered ? 'accent' : 'muted'
}

export function overflowCueAppearance(tone: 'hidden' | 'muted' | 'accent') {
  if (tone === 'accent') return { fillOpacity: 0.96, strokeWidth: 2, tintOpacity: 0.18 }
  return { fillOpacity: 0.88, strokeWidth: 1, tintOpacity: tone === 'muted' ? 0.12 : 0 }
}

export function canvasColorWithAlpha(color: string, alpha: number): string {
  const safeAlpha = Math.min(1, Math.max(0, alpha))
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1]
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((value) => value + value).join('') : hex
    return `rgba(${Number.parseInt(expanded.slice(0, 2), 16)},${Number.parseInt(expanded.slice(2, 4), 16)},${Number.parseInt(expanded.slice(4, 6), 16)},${safeAlpha})`
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(color.trim())
  if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${safeAlpha})`
  return `rgba(0,0,0,${safeAlpha})`
}

export function transparentCanvasColor(color: string): string {
  return canvasColorWithAlpha(color, 0)
}
import { computeAdaptiveTextDimensions } from './canvasLayout'
