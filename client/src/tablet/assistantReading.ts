/** Поле занимает примерно треть, остальное место остаётся для чтения. */
export function assistantInputHeight(panelHeight: number): number {
  return Math.max(44, Math.min(160, Math.round((panelHeight - 60) / 3)))
}

export function isReadingLatest(view: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return view.scrollHeight - view.clientHeight - view.scrollTop <= 32
}
