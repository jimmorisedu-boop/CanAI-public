// Режим кропа: обрезка конкретной картинки. Хранит id целевой картинки,
// пока режим активен. Шина связывает меню картинки, канвас и топ-класс.
type Listener = (target: string | null) => void

let target: string | null = null
const listeners = new Set<Listener>()

export function getCropTarget(): string | null {
  return target
}

export function setCropTarget(id: string | null): void {
  target = id
  listeners.forEach((l) => l(id))
}

export function onCropTarget(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
