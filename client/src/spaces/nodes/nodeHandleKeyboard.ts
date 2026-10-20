import type { KeyboardEvent } from 'react'

/** Клавиатура идёт тем же click-connect путём React Flow, что и мышь:
 * валидатор соединений и production onConnect остаются единственными. */
export function handleNodePortKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) event.currentTarget.click()
}
