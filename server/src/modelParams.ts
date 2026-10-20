import { CATALOG, normalizeEndpoint, ADAPTER_VERSION, type ModelKind } from './catalog.js'
import { effectiveCatalogPreset } from './modelRefLimits.js'
import type { IncomingRef } from './refs.js'
import { parameterActive } from '../../packages/model-catalog/parameterRules.js'
import { executorCompatibilityError } from '../../packages/model-catalog/version.js'

export function modelExecutionError(modelId: string | undefined, kind: ModelKind, refs: IncomingRef[]): string | null {
  const selected = CATALOG.find(model => model.id === modelId)
  const selectedError = executorCompatibilityError(selected) ?? (selected?.lifecycle === 'disabled' ? 'Model disabled for new runs. Select another model.' : null)
  if (selectedError) return selectedError
  const model = effectiveCatalogPreset(modelId, kind, refs)
  return executorCompatibilityError(model) ?? (model?.lifecycle === 'disabled' ? 'Model disabled for new runs. Select another model.' : null)
}

export function validateModelParams(
  modelId: string | undefined,
  fallbackKind: ModelKind,
  refs: IncomingRef[],
  params: Record<string, unknown>,
): boolean {
  if (modelExecutionError(modelId, fallbackKind, refs)) return false
  if (modelId && !CATALOG.some(model => model.id === modelId) && !normalizeEndpoint(modelId)) return false
  const preset = effectiveCatalogPreset(modelId, fallbackKind, refs)
  if (!preset) return true
  if (preset.lifecycle === 'disabled' || (preset.minExecutorVersion ?? 1) > ADAPTER_VERSION) return false

  const specs = new Map((preset.params ?? []).map((spec) => [spec.name, spec]))
  for (const [name, value] of Object.entries(params)) {
    const spec = specs.get(name)
    if (!spec) return false
    if (!parameterActive(spec, preset.params ?? [], params)) return false
    if (spec.widget === 'boolean') {
      if (typeof value !== 'boolean') return false
    } else if (spec.widget === 'number' || spec.widget === 'slider' || spec.widget === 'seed') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false
      if ((spec.step === 1 || spec.widget === 'seed') && !Number.isInteger(value)) return false
      if (spec.min != null && value < spec.min) return false
      if (spec.max != null && value > spec.max) return false
    } else {
      if (typeof value !== 'string') return false
      if (spec.options && !spec.options.some((option) => option.value === value)) return false
    }
  }
  return true
}
