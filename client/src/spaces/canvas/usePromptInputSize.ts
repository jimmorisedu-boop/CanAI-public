import { useCallback, useEffect, useState, type PointerEvent, type RefObject } from 'react'
import { promptLineHeights, resolvePromptInputHeight } from './promptInputHeight'

const MIN_HEIGHT = 100
const MAX_VIEWPORT_SHARE = 0.7

// Размер поля промпта: автоподбор высоты по содержимому и ручная тяга за
// верхнюю кромку. Своя область ответственности с четырьмя состояниями —
// в теле PromptBar она тонула среди референсов, моделей и помощника.
export function usePromptInputSize(input: {
  textareaRef: RefObject<HTMLTextAreaElement>
  prompt: string
  chatOpen: boolean
}) {
  const { textareaRef, prompt, chatOpen } = input
  const [isFocused, setIsFocused] = useState(false)
  const [maxHeight, setMaxHeight] = useState(250)
  const [isResizing, setIsResizing] = useState(false)
  const [manuallySized, setManuallySized] = useState(false)

  const startResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault() // не терять фокус с textarea
    setIsResizing(true)
    const startY = event.clientY
    const startHeight = maxHeight
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (next: globalThis.PointerEvent) => {
      const wanted = startHeight + (startY - next.clientY)
      const limit = Math.round(window.innerHeight * MAX_VIEWPORT_SHARE)
      setMaxHeight(Math.max(MIN_HEIGHT, Math.min(limit, wanted)))
      setManuallySized(true)
    }
    const stop = () => {
      setIsResizing(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }, [maxHeight])

  // высота поля пересчитывается по содержимому, но не выше свободного места
  // над баром: иначе поле уезжало бы под шапку
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'

    const bar = textarea.closest('.prompt-bar') as HTMLElement | null
    const aroundTextarea = bar
      ? bar.getBoundingClientRect().height - textarea.getBoundingClientRect().height
      : 120

    const next = resolvePromptInputHeight({
      promptIsEmpty: prompt.trim() === '',
      contentHeight: textarea.scrollHeight + 2,
      preferredHeight: maxHeight,
      availableHeight: window.innerHeight - aroundTextarea - 40,
      isFocused,
      isResizing,
      manuallySized,
      panel: chatOpen ? 'chat' : 'prompt',
      ...promptLineHeights(getComputedStyle(textarea)),
    })
    textarea.style.height = `${next}px`
    // ⚠️ Полосу решает НАСТОЯЩИЙ размер поля, а не `next`: min-height и
    // max-height из стилей его поправляют, и сравнение с `next` рисовало
    // полосу у пустого поля. В покое поле — превью: прокрутка начинается,
    // когда в него встали.
    const resting = !isFocused && (chatOpen || !(isResizing || manuallySized))
    textarea.style.overflowY = !resting && textarea.scrollHeight > textarea.clientHeight + 1 ? 'auto' : 'hidden'
  }, [chatOpen, isFocused, isResizing, manuallySized, maxHeight, prompt, textareaRef])

  useEffect(() => {
    window.addEventListener('resize', adjustHeight)
    return () => window.removeEventListener('resize', adjustHeight)
  }, [adjustHeight])

  useEffect(() => {
    adjustHeight()
  }, [adjustHeight])

  return { isFocused, setIsFocused, startResize, adjustHeight }
}
