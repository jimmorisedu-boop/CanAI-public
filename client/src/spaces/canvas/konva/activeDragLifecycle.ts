interface ActiveDrag {
  owner: object
  cancel: () => void
}

let active: ActiveDrag | null = null

/** Registers the one Konva drag that may currently outlive its React node. */
export function registerActiveDrag(owner: object, cancel: () => void): void {
  if (active && active.owner !== owner) active.cancel()
  active = { owner, cancel }
}

/** Removes a normally completed drag without invoking its cancellation path. */
export function clearActiveDrag(owner: object): void {
  if (active?.owner === owner) active = null
}

/** Cancels an admitted drag on blur/unmount and makes late end events harmless. */
export function cancelActiveDrag(owner: object): void {
  if (active?.owner !== owner) return
  const current = active
  active = null
  current.cancel()
}
