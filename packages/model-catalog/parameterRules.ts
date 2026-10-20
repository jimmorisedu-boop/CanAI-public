import type { ParamSpec } from './catalog.js'

export function parameterActive(spec: ParamSpec, specs: readonly ParamSpec[], values: Record<string, unknown>): boolean {
  if (!spec.activeWhen) return true
  const value = values[spec.activeWhen.name] ?? specs.find(item => item.name === spec.activeWhen!.name)?.default
  return spec.activeWhen.values.includes(String(value))
}

/** A deliberate form change also clears controls which no longer apply. */
export function changeParameter(specs: readonly ParamSpec[], values: Record<string, unknown>, name: string, value: unknown): Record<string, unknown> {
  const result = { ...values, [name]: value }
  for (const spec of specs) if (spec.activeWhen?.name === name && !parameterActive(spec, specs, result)) delete result[spec.name]
  return result
}
