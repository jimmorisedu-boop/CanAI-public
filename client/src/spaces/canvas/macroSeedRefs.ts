import type { GenRef } from '../../types'
import { toGenRefs, type SelectionRef } from './konva/selection'

export function toMacroSeedRefs(
  refs: SelectionRef[],
  hasTypedInput: boolean,
): Promise<GenRef[]> {
  return toGenRefs(refs, hasTypedInput ? 'video' : 'image')
}
