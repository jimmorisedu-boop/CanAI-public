interface DragEndEventTarget {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export function armLostDragEndSafety(
  target: DragEndEventTarget,
  safety: () => void,
  cancel: () => void = safety,
): void {
  const finish = (cancelled: boolean) => {
    target.removeEventListener('mouseup', onEnd)
    target.removeEventListener('touchend', onEnd)
    target.removeEventListener('touchcancel', onCancel)
    if (cancelled) cancel()
    else safety()
  }
  const onEnd = () => finish(false)
  const onCancel = () => finish(true)
  target.addEventListener('mouseup', onEnd)
  target.addEventListener('touchend', onEnd)
  target.addEventListener('touchcancel', onCancel)
}
