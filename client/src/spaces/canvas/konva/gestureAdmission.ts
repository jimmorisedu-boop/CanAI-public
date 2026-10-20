/**
 * Admission for a gesture whose mutation lease is asynchronous.
 *
 * A pointer can be released while the selection request is in flight. The
 * generation token makes a late response harmless: it can never resurrect a
 * cancelled drag. Keeping this tiny state machine independent of Konva also
 * lets the tablet board use exactly the same pointer lifecycle.
 */
export interface GestureAdmission {
  begin(
    acquire: () => Promise<boolean>,
    onGranted: () => void,
    onRejected?: () => void,
  ): void
  cancel(): void
  isPending(): boolean
}

export function createGestureAdmission(): GestureAdmission {
  let generation = 0
  let pending = false

  const settle = (token: number, granted: boolean, onGranted: () => void, onRejected?: () => void) => {
    if (token !== generation) return
    pending = false
    if (granted) onGranted()
    else onRejected?.()
  }

  return {
    begin(acquire, onGranted, onRejected) {
      const token = ++generation
      pending = true
      void Promise.resolve()
        .then(acquire)
        .then(
          (granted) => settle(token, granted, onGranted, onRejected),
          () => settle(token, false, onGranted, onRejected),
        )
    },
    cancel() {
      generation += 1
      pending = false
    },
    isPending: () => pending,
  }
}
