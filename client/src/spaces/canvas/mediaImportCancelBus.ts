type CancelHandler = (taskId: string) => void

let handler: CancelHandler | null = null

export function registerMediaImportCancelHandler(next: CancelHandler): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

export function requestMediaImportCancel(taskId: string): void {
  handler?.(taskId)
}
