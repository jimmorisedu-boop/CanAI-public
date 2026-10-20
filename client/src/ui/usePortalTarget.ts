import { useEffect, useState } from 'react'

// Портал в элемент, который может смонтироваться ПОЗЖЕ создателя (топ-бар
// появляется после канваса). Без подписки на появление кнопка экспорта молча
// пропадала до первого случайного ре-рендера, совпавшего с наличием элемента.
export function observePortalTarget(id: string, onTarget: (target: HTMLElement | null) => void): () => void {
  let current = document.getElementById(id)
  onTarget(current)
  const observer = new MutationObserver(() => {
    const next = document.getElementById(id)
    if (next === current) return
    current = next
    onTarget(next)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}

export function usePortalTarget(id: string): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : document.getElementById(id),
  )

  useEffect(() => {
    return observePortalTarget(id, setTarget)
  }, [id])

  return target
}
