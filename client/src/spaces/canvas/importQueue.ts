import { newId } from '../../ui/ids'
export interface ImportTask {
  id: string
  name: string
  loaded: number
  total: number
  state: 'uploading' | 'error'
  error?: string
}

type Operation = (signal: AbortSignal, progress: (loaded: number, total: number) => void) => Promise<void>

const tasks = new Map<string, ImportTask>()
const operations = new Map<string, Operation>()
const controllers = new Map<string, AbortController>()
const listeners = new Set<() => void>()
let snapshot: ImportTask[] = []

function emit() {
  snapshot = [...tasks.values()]
  listeners.forEach((listener) => listener())
}

async function execute(id: string): Promise<void> {
  const task = tasks.get(id)
  const operation = operations.get(id)
  if (!task || !operation) return
  const controller = new AbortController()
  controllers.set(id, controller)
  tasks.set(id, { ...task, loaded: 0, state: 'uploading', error: undefined })
  emit()
  try {
    await operation(controller.signal, (loaded, total) => {
      const current = tasks.get(id)
      if (!current) return
      tasks.set(id, { ...current, loaded, total })
      emit()
    })
    tasks.delete(id)
    operations.delete(id)
    controllers.delete(id)
    emit()
  } catch (cause) {
    controllers.delete(id)
    if (controller.signal.aborted) return
    const current = tasks.get(id)
    if (!current) return
    tasks.set(id, {
      ...current,
      state: 'error',
      error: cause instanceof Error ? cause.message : "Import failed",
    })
    emit()
    throw cause
  }
}

export function startImport(file: File, operation: Operation): Promise<void> {
  const id = newId()
  tasks.set(id, { id, name: file.name || "File", loaded: 0, total: file.size, state: 'uploading' })
  operations.set(id, operation)
  emit()
  return execute(id)
}

export function cancelImport(id: string): void {
  controllers.get(id)?.abort()
  controllers.delete(id)
  tasks.delete(id)
  operations.delete(id)
  emit()
}

export function retryImport(id: string): void {
  void execute(id).catch(() => {})
}

export function dismissImport(id: string): void {
  tasks.delete(id)
  operations.delete(id)
  emit()
}

export function subscribeImports(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getImports(): ImportTask[] {
  return snapshot
}
