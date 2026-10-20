// Режим таймлайна: правка одного клипа. Хранит id целевого видео, пока режим
// активен — тот же приём, что у cropBus и sketchBus. Шина связывает меню
// объекта, канвас и оверлей, не заставляя их знать друг о друге.
type Listener = (target: string | null) => void

let target: string | null = null
const listeners = new Set<Listener>()

export function getTimelineTarget(): string | null {
  return target
}

export function setTimelineTarget(id: string | null): void {
  if (target === id) return
  target = id
  // Закрыли режим — сбрасываем и презентацию, чтобы следующий клип открылся
  // снова в overlay, а не «застрял» в canvas-виде. ⚠️ Сбрасываем С ОПОВЕЩЕНИЕМ:
  // молчаливая запись оставляла подписчиков (CanvasSpace: «холст на виду») в
  // прежнем виде, а оверлей следующего клипа публиковал 'overlay' — уже
  // равный текущему — и ничего никому не сообщал. Холст так и оставался
  // «проглядываемым» под новым режимом.
  if (id === null) setTimelinePresentation('overlay')
  listeners.forEach((listener) => listener(id))
}

export function onTimelineTarget(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Презентация режима (§9.1 ТЗ): overlay — видимая правка, canvas — оверлей
// спрятан и человек видит настоящий CanvasItem. Шина та же: канвас убирает
// режимную рамку (prompt-dock и т.п. снова видны), а оверлей живёт.
export type TimelinePresentation = 'overlay' | 'canvas'

let presentation: TimelinePresentation = 'overlay'
const presentationListeners = new Set<(value: TimelinePresentation) => void>()

export function getTimelinePresentation(): TimelinePresentation {
  return presentation
}

export function setTimelinePresentation(value: TimelinePresentation): void {
  if (presentation === value) return
  presentation = value
  presentationListeners.forEach((listener) => listener(value))
}

/**
 * Держит ли режим правки клавиатуру и мышь холста. Цель в шине есть и в
 * презентации 'canvas' (оверлей спрятан, человек разглядывает снятый кадр на
 * доске), но там холст обязан жить: хоткеи, плееры и перемотка звука работают
 * как обычно. Поэтому проверять надо не «есть ли цель», а эту функцию — на
 * ней сторожат холст useCanvasHotkeys, useMediaPlayerHotkeys и AudioItem.
 * ⚠️ Escape в презентации 'canvas' принадлежит оверлею (он вернёт себя), и
 * холст его брать не вправе (см. useCanvasHotkeys).
 */
export function timelineBlocksCanvas(): boolean {
  return target !== null && presentation === 'overlay'
}

export function onTimelinePresentation(listener: (value: TimelinePresentation) => void): () => void {
  presentationListeners.add(listener)
  return () => {
    presentationListeners.delete(listener)
  }
}
