import type { ProjectRef } from '../types'

export function projectKey(ref: ProjectRef): string {
  if (ref.source !== 'local') throw new Error('Only local boards are available')
  if (!ref.id) throw new Error('Empty board ID')
  return `local:${ref.id}`
}

export function parseProjectKey(value: string): ProjectRef {
  const separator = value.indexOf(':')
  if (separator < 0) throw new Error('Invalid board key format')
  const source = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (source !== 'local') throw new Error('Only local boards are available')
  if (!id) throw new Error('Empty board ID')
  return { source: 'local', id }
}
