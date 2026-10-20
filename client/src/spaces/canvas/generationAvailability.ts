import type { ServerStatus } from '../../types'

/** Generation in the local edition is provided by the local fal/mock server. */
export function canGenerate(status: ServerStatus | null, _projectSource = 'local'): boolean {
  if (!status) return false
  return status.mockMode || status.falConfigured
}

export function canStartGeneration(
  status: ServerStatus | null,
  catalogAvailable: boolean,
  _projectSource = 'local',
): boolean {
  return canGenerate(status) && catalogAvailable
}
