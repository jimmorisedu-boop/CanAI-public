export function canvasOwnsCopy(input: {
  selectedCanvasItems: number
  selectedText: string
}): boolean {
  return input.selectedCanvasItems > 0 && input.selectedText.trim().length === 0
}

export function browserSelectedText(): string {
  return typeof window === 'undefined' ? '' : window.getSelection()?.toString() ?? ''
}
