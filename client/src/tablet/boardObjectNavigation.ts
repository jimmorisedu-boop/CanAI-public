import { useRef, type KeyboardEvent } from 'react'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { boardHistoryInputAllowed } from './boardHistoryInput'

const KIND = { text: 'Text', image: 'Image', video: 'Video', audio: 'Audio', link: 'Link' }
export function boardObjectLabel(item: CanvasItem): string {
  const title = item.name || item.text || item.link?.title || item.link?.url
  return `${KIND[item.kind]}${title ? `: ${title.slice(0, 100)}` : ''}`
}

/** Reveal a chosen object without zooming or disturbing an already visible one. */
export function revealBoardObject(store: CanvasStore, id: string, viewport: { w: number; h: number }) {
  const item = store.getItem(id)
  if (!item) return
  const camera = store.getCamera()
  const x = item.x * camera.scale + camera.x
  const y = item.y * camera.scale + camera.y
  if (x >= 24 && y >= 24 && x + item.w * camera.scale <= viewport.w - 24 && y + item.h * camera.scale <= viewport.h - 24) return
  store.setCamera({ ...camera,
    x: viewport.w / 2 - (item.x + item.w / 2) * camera.scale,
    y: viewport.h / 2 - (item.y + item.h / 2) * camera.scale,
  })
}

export function useBoardObjectNavigation(store: CanvasStore, reveal: (id: string) => void,
  activate: (id: string) => void, readOnly: boolean) {
  const cursor = useRef<string | null>(null)
  const anchor = useRef<string | null>(null)
  const ownSelection = useRef<ReadonlySet<string> | null>(null)
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.defaultPrevented || event.altKey || event.nativeEvent?.isComposing) return
    if (!boardHistoryInputAllowed(event.target)) return
    const items = store.getItems()
    if (!items.length) return
    const selected = store.getSelectedIds()
    // Space changes selection, not the traversal position. A different Set
    // from a pointer/list action replaces both the cursor and range anchor.
    if (selected !== ownSelection.current || !items.some((item) => item.id === cursor.current)) {
      cursor.current = [...selected].reverse().find((id) => items.some((item) => item.id === id)) ?? null
      anchor.current = cursor.current
      ownSelection.current = selected
    }
    const select = (ids: string[]) => {
      store.setSelection(ids)
      ownSelection.current = store.getSelectedIds()
    }
    const current = cursor.current
    let index = items.findIndex((item) => item.id === current)
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() !== 'a') return
      event.preventDefault()
      select(items.map((item) => item.id))
      return
    }
    switch (event.key) {
      case 'ArrowRight': case 'ArrowDown': index = Math.min(items.length - 1, index + 1); break
      case 'ArrowLeft': case 'ArrowUp': index = Math.max(0, index - 1); break
      case 'Home': index = 0; break
      case 'End': index = items.length - 1; break
      case 'Escape': event.preventDefault(); select([]); return
      case 'Enter': {
        event.preventDefault()
        const id = current ?? items[0]!.id
        if (!selected.has(id)) select([id])
        cursor.current = id
        reveal(id)
        if (!readOnly) activate(id)
        return
      }
      case ' ': {
        event.preventDefault()
        const id = current ?? items[0]!.id
        select(selected.has(id) ? [...selected].filter((selectedId) => selectedId !== id) : [...selected, id])
        cursor.current = id
        anchor.current ??= id
        reveal(id)
        return
      }
      default: return
    }
    event.preventDefault()
    const id = items[index]!.id
    if (event.shiftKey) {
      anchor.current ??= current ?? id
      const start = Math.max(0, items.findIndex((item) => item.id === anchor.current))
      select(items.slice(Math.min(start, index), Math.max(start, index) + 1).map((item) => item.id))
    } else {
      anchor.current = id
      select([id])
    }
    cursor.current = id
    reveal(id)
  }
}
