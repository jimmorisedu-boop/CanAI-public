import { useEffect, useState } from 'react'

export const COMPACT_LAYOUT_QUERY = '(max-width: 600px)'

export function compactLayoutSnapshot(query: Pick<MediaQueryList, 'matches'>): boolean {
  return query.matches
}

export function subscribeCompactLayout(
  query: Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>,
  listener: () => void,
): () => void {
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => (
    typeof window !== 'undefined'
      && compactLayoutSnapshot(window.matchMedia(COMPACT_LAYOUT_QUERY))
  ))

  useEffect(() => {
    const query = window.matchMedia(COMPACT_LAYOUT_QUERY)
    const sync = () => setCompact(compactLayoutSnapshot(query))
    sync()
    return subscribeCompactLayout(query, sync)
  }, [])

  return compact
}
