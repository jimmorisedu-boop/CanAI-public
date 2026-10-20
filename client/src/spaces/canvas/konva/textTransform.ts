import { computeAdaptiveTextDimensions } from './canvasLayout'

const MIN_FONT_SIZE = 8
const CORNER_ANCHORS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right'])

export interface TextTransformState {
  w: number
  h: number
  fontSize: number
}

export interface TextTransformNode {
  scaleX(next?: number): number
  scaleY(next?: number): number
}

export function stepTextTransform(
  state: TextTransformState,
  node: TextTransformNode,
  text?: string,
  activeAnchor?: string | null,
): TextTransformState {
  const scaleX = node.scaleX()
  const scaleY = node.scaleY()
  node.scaleX(1)
  node.scaleY(1)

  const isCorner = activeAnchor ? CORNER_ANCHORS.has(activeAnchor) : Math.abs(scaleX - 1) >= 1e-9 && Math.abs(scaleY - 1) >= 1e-9
  const effectiveScaleY = isCorner && Math.abs(scaleY - 1) < 1e-9 ? scaleX : scaleY
  const effectiveScaleX = isCorner && Math.abs(scaleX - 1) < 1e-9 ? scaleY : scaleX
  const fontScale = isCorner ? Math.sqrt(effectiveScaleX * effectiveScaleY) : 1
  let nextW = Math.max(20, state.w * effectiveScaleX)
  let nextH = Math.max(20, state.h * effectiveScaleY)
  const nextFontSize = Math.max(MIN_FONT_SIZE, state.fontSize * fontScale)

  if (!isCorner && Math.abs(scaleX - 1) > 1e-9 && Math.abs(scaleY - 1) < 1e-9 && text !== undefined) {
    nextH = computeAdaptiveTextDimensions(text, nextFontSize, nextW).h
  }
  return { w: nextW, h: nextH, fontSize: nextFontSize }
}
