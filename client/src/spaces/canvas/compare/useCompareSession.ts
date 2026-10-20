import { useSyncExternalStore } from 'react'
import { getCompareSession, onCompareSession, type CompareSession } from './compareBus'

// Реактивное чтение шины сравнения. Сама шина остаётся обычным модулем без
// React (как cropBus/sketchBus) — подписка живёт отдельно.
export function useCompareSession(): CompareSession | null {
  return useSyncExternalStore(onCompareSession, getCompareSession, () => null)
}
