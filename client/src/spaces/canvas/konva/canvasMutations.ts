import type {
  ArchivedItem,
  CanvasDoc,
  CanvasItem,
  PinnedAsset,
  Placeholder,
} from './types'

export interface CanvasPatch<T> {
  values: Partial<T>
  unset: string[]
}

export type CanvasMutation =
  | { type: 'item.add'; objectId: string; payload: CanvasItem }
  | { type: 'item.patch'; objectId: string; payload: CanvasPatch<CanvasItem> }
  | { type: 'item.delete'; objectId: string; payload: Record<string, never> }
  | {
      type: 'item.order'
      objectId: 'board-order'
      payload: {
        ids: string[]
        /** Objects intentionally moved by this semantic order command. */
        movedIds?: string[]
      }
    }
  | { type: 'archive.add'; objectId: string; payload: ArchivedItem }
  | { type: 'archive.restore'; objectId: string; payload: CanvasItem }
  | { type: 'archive.delete'; objectId: string; payload: Record<string, never> }
  | { type: 'asset.pin'; objectId: string; payload: PinnedAsset }
  | { type: 'asset.unpin'; objectId: string; payload: { slot: number } }
  | { type: 'pending.add'; objectId: string; payload: Placeholder }
  | { type: 'pending.patch'; objectId: string; payload: CanvasPatch<Placeholder> }
  | { type: 'pending.delete'; objectId: string; payload: Record<string, never> }
  | {
      type: 'pending.complete'
      objectId: string
      payload: {
        pendingId: string
        jobId: string
        /** Stable logical identity retained when a pending result becomes an item. */
        item: CanvasItem
      }
    }
  | {
      type: 'board.patch'
      objectId: 'board'
      payload: CanvasPatch<Pick<CanvasDoc, 'handledGenerationLaunchIds'>>
    }

export interface CanvasMutationEntry {
  mutation: CanvasMutation
  inverse: CanvasMutation | null
}

export interface CanvasMutationEnvelope extends CanvasMutationEntry {
  origin: 'local' | 'remote'
  /** System progress is shared durably but never becomes a user undo step. */
  recordUndo?: boolean
  /** Одно атомарное пользовательское действие. Первое значение также
   * продублировано в mutation/inverse для обратной совместимости слушателей. */
  batch?: readonly CanvasMutationEntry[]
}

export interface CanvasMutationPort {
  subscribeMutations(listener: (event: CanvasMutationEnvelope) => void): () => void
  applyRemote(mutation: CanvasMutation): void
  applyRemoteBatch?(mutations: readonly CanvasMutation[]): void
}

/**
 * Возвращает один допустимый минимальный набор объектов, чьё перемещение
 * объясняет новый порядок. Остальные образуют общую наибольшую возрастающую
 * подпоследовательность и сохраняют взаимный порядок — именно это проверяет
 * сервер при item.order.
 */
export function orderMovedIds(before: readonly string[], after: readonly string[]): string[] {
  const positions = new Map(after.map((id, index) => [id, index]))
  const candidates = before.flatMap((id) => {
    const position = positions.get(id)
    return position == null ? [] : [{ id, position }]
  })
  const tails: number[] = []
  const tailCandidates: number[] = []
  const previous = new Array<number>(candidates.length).fill(-1)
  candidates.forEach((candidate, index) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (tails[middle]! < candidate.position) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tailCandidates[low - 1]!
    tails[low] = candidate.position
    tailCandidates[low] = index
  })
  const kept = new Set<string>()
  let cursor = tailCandidates[tails.length - 1] ?? -1
  while (cursor >= 0) {
    kept.add(candidates[cursor]!.id)
    cursor = previous[cursor]!
  }
  return after.filter((id) => !kept.has(id))
}

export function patchWithInverse<T extends object>(
  current: T,
  patch: Partial<T>,
): { forward: CanvasPatch<T>; inverse: CanvasPatch<T> } {
  const forwardValues: Partial<T> = {}
  const forwardUnset: string[] = []
  const inverseValues: Partial<T> = {}
  const inverseUnset: string[] = []
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (patch[key] === undefined) forwardUnset.push(String(key))
    else forwardValues[key] = patch[key]
    if (current[key] === undefined) inverseUnset.push(String(key))
    else inverseValues[key] = current[key]
  }
  return {
    forward: { values: forwardValues, unset: forwardUnset },
    inverse: { values: inverseValues, unset: inverseUnset },
  }
}

/**
 * ⚠️ Правка приходит и с сервера, а там её никто не обязан собрать ровно так,
 * как собирает магазин. Кривая правка не имеет права уронить доску: без
 * `values` или `unset` она просто ничего не меняет.
 */
export function applyPatch<T extends object>(current: T, patch: CanvasPatch<T>): T {
  const values = patch.values && typeof patch.values === 'object' ? patch.values : {}
  const next = { ...current, ...values }
  for (const key of Array.isArray(patch.unset) ? patch.unset : []) delete (next as Record<string, unknown>)[key]
  return next
}

/**
 * Обработанные серии генерации — множество, а не значение.
 *
 * ⚠️ Каждый участник присылает список целиком; при «последний записавший
 * побеждает» два одновременных запуска теряли бы один из номеров. Поэтому
 * списки объединяются — ровно так же, как на сервере команды
 * (`mergeHandledLaunches`): прежние, затем новые, последние 100.
 */
export function mergeHandledLaunchIds(current: readonly string[], incoming: readonly unknown[]): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const id of [...current, ...incoming]) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  return merged.slice(-100)
}

export function applyBoardPatch(
  current: readonly string[],
  payload: CanvasPatch<{ handledGenerationLaunchIds?: string[] }>,
): string[] {
  if (payload.unset.includes('handledGenerationLaunchIds')) return []
  return mergeHandledLaunchIds(current, payload.values.handledGenerationLaunchIds ?? [])
}
