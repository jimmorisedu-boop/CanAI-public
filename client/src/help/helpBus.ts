export interface HelpRequest {
  topicId?: string
  nonce: number
}

type HelpListener = (request: HelpRequest) => void

let nonce = 0
let current: HelpRequest = { nonce: 0 }
const listeners = new Set<HelpListener>()

/**
 * Open the application help from a surface that does not own the modal.
 *
 * Keeping this as a tiny module-level bus lets canvas controls, the first-run
 * guide, and the gallery use the same Help dialog without adding routing or a
 * browser-storage dependency. The nonce makes repeated requests for the same
 * topic observable by React subscribers.
 */
export function openHelp(topicId?: string): void {
  current = { topicId, nonce: ++nonce }
  listeners.forEach((listener) => listener(current))
}

export function getHelpRequest(): HelpRequest {
  return current
}

export function subscribeHelp(listener: HelpListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
