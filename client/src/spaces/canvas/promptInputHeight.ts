// Высота поля в покое берётся у САМОГО поля (restingHeight — одна строка,
// previewHeight — две), а не прибитыми 34 и 62 px: у окна помощника отступы и
// рамка крупнее, и в 34 px его строка не помещалась — пустое поле рисовало
// полосу прокрутки (жалоба 19.10.2026 со снимком). Умолчания — прежние числа
// обычного промпта.
export function resolvePromptInputHeight({
  promptIsEmpty,
  contentHeight,
  preferredHeight,
  availableHeight,
  isFocused,
  isResizing,
  manuallySized,
  panel = 'prompt',
  restingHeight = 34,
  previewHeight = 62,
}: {
  promptIsEmpty: boolean
  contentHeight: number
  preferredHeight: number
  availableHeight: number
  isFocused: boolean
  isResizing: boolean
  manuallySized: boolean
  panel?: 'prompt' | 'chat'
  restingHeight?: number
  previewHeight?: number
}): number {
  const limit = Math.max(100, Math.min(preferredHeight, availableHeight))
  if (panel === 'prompt' && (isResizing || manuallySized)) return limit
  if (!isFocused) return promptIsEmpty ? restingHeight : Math.min(contentHeight, Math.max(restingHeight, previewHeight))
  return Math.min(contentHeight, limit)
}

/** Одна и две строки поля с его отступами и рамкой — по вычисленным стилям. */
export function promptLineHeights(style: {
  lineHeight: string
  fontSize: string
  paddingTop: string
  paddingBottom: string
  borderTopWidth: string
  borderBottomWidth: string
}): { restingHeight: number; previewHeight: number } {
  const px = (value: string) => {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  // `normal` не число: берём кегль × 1.5, как у нашего поля
  const line = px(style.lineHeight) || px(style.fontSize) * 1.5 || 20
  const chrome = px(style.paddingTop) + px(style.paddingBottom)
    + px(style.borderTopWidth) + px(style.borderBottomWidth)
  return {
    restingHeight: Math.max(34, Math.ceil(chrome + line)),
    previewHeight: Math.max(62, Math.ceil(chrome + line * 2)),
  }
}
