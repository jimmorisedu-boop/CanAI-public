/** Editable controls and modal scopes own their input history. */
export function boardHistoryInputAllowed(target: EventTarget | null, boardOnly = false): boolean {
  if (!(target instanceof Element)) return false
  if (boardOnly && target.closest('[data-tablet-interactive]') && !target.closest('video')) return false
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"], [inert]')) return false
  if (document.querySelector('[aria-modal="true"]')) return false
  return Boolean(target.closest(boardOnly ? '.tablet-board' : '.tablet-screen, .tablet-board'))
}
