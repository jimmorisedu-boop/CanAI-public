// Режим скетча: рисование поверх конкретной картинки. Пока режим активен,
// хранится id этой картинки — при генерации она уходит в fal ВМЕСТЕ со
// скетчем (склеенная в одно изображение). Шина связывает меню картинки,
// канвас (панели/баннер) и промпт-бар.
type Listener = (target: string | null) => void

let target: string | null = null
const listeners = new Set<Listener>()

export function getSketchTarget(): string | null {
  return target
}

export function setSketchTarget(id: string | null): void {
  target = id
  listeners.forEach((l) => l(id))
}

export function onSketchTarget(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
