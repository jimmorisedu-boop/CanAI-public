import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'

/**
 * Что на доске сейчас трогать нельзя — ключом для `useSyncExternalStore`.
 *
 * ⚠️ Раньше доска планшета подписывалась на ВСЮ совместную работу, и каждый
 * кадр чужого курсора перерисовывал все видимые объекты (пункт 3.8, находка
 * С-9 — на компьютере это убрали 24.09, планшет остался без ускорения). Доске
 * от совместной работы нужно одно: какие объекты закрыты чужим выделением.
 * Ключ меняется только вместе с этим набором, а курсоры его не трогают.
 */

/** Права на доску нет — нельзя ничего. */
export const ALL_LOCKED = '*'

/** Заведомо ничей объект: ответ о нём — это ответ о праве на доску целиком. */
const FREE_PROBE = '\u0000free'

export function boardLockKey(store: CanvasStore): string {
  const port = store.getCollaboration()
  if (!port) return ''
  if (!store.canMutateItems([FREE_PROBE])) return ALL_LOCKED
  const held = port.heldObjectIds?.()
    // Порт без таблицы (старый или проверочный) — спрашиваем поимённо о тех,
    // у кого вообще есть аренда.
    ?? new Set([...new Set(port.getSnapshot().locks.map((lease) => lease.objectId))]
      .filter((id) => !store.canMutateItems([id])))
  return held.size === 0 ? '' : [...held].sort().join('\n')
}

/** null — закрыто всё. */
export function lockedIdsFromKey(key: string): ReadonlySet<string> | null {
  if (key === ALL_LOCKED) return null
  return new Set(key ? key.split('\n') : [])
}
