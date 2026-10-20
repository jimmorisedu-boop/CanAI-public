import { askConfirm } from '../ui/confirmBus'

export function confirmDiscardDraft(dirty: boolean): Promise<boolean> {
  if (!dirty) return Promise.resolve(true)
  return askConfirm({
    title: 'Discard changes?',
    detail: 'Changes in this editor have not been applied to the board yet.',
    confirmLabel: 'Discard',
    cancelLabel: 'Continue editing',
    danger: true,
  })
}
