import type { GallerySort } from './galleryProjectList'

export const SORT_OPTIONS: ReadonlyArray<{ value: GallerySort; label: string }> = [
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Newest' },
]

export type GallerySortNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

export function moveGallerySort(current: GallerySort, key: GallerySortNavigationKey): GallerySort {
  if (key === 'Home') return SORT_OPTIONS[0].value
  if (key === 'End') return SORT_OPTIONS[SORT_OPTIONS.length - 1].value
  const index = Math.max(0, SORT_OPTIONS.findIndex((option) => option.value === current))
  const offset = key === 'ArrowDown' ? 1 : -1
  return SORT_OPTIONS[(index + offset + SORT_OPTIONS.length) % SORT_OPTIONS.length].value
}
