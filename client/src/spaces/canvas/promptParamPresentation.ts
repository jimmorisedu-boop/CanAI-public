import type { ParamSpec } from '../../types'
import { parameterActive } from '../../../../packages/model-catalog/parameterRules'

const primaryKeys = ['aspect_ratio', 'resolution', 'image_size', 'duration', 'quality', 'generate_audio']
const secondaryKeys = new Set(['seed', 'output_format', 'enable_safety_checker', 'system_prompt'])
const labels: Record<string, string> = {
  aspect_ratio: "Format", resolution: "Size", image_size: "Size",
  duration: "Length", quality: "Quality", generate_audio: "Audio",
}

function presentationKey(name: string): string {
  const key = name.replace(/^custom__/, '')
  return key === 'aspect' ? 'aspect_ratio' : key === 'size' ? 'resolution' : key
}

/** Only presentation changes. API names, enum values and conditions stay intact. */
export function promptParamPresentation(params: ParamSpec[], values: Record<string, unknown>) {
  const displayParams = params.map(spec => {
    const key = presentationKey(spec.name)
    const shortDuration = key === 'duration' && (spec.widget === 'number' || spec.widget === 'slider')
      && Number.isInteger(spec.min) && Number.isInteger(spec.max) && (spec.step ?? 1) === 1
      && spec.max! >= spec.min! && spec.max! - spec.min! <= 20
    return {
      ...spec,
      label: labels[key] ?? spec.label,
      ...(shortDuration ? { widget: 'slider' as const } : {}),
      ...(spec.options && primaryKeys.includes(key) ? {
        options: spec.options.map(option => ({
          ...option,
          label: option.value === 'auto' && /^auto$/i.test(option.label) ? "Auto"
            : key === 'duration' && /^\d+(?:\.\d+)?$/.test(option.value) ? `${option.value} sec` : option.label,
        })),
      } : {}),
    }
  })
  const active = displayParams.filter(spec => parameterActive(spec, displayParams, values))
  const important = primaryKeys.flatMap(key => active.filter(spec => presentationKey(spec.name) === key))
  const candidates = important.length ? important : active.filter(spec => !secondaryKeys.has(presentationKey(spec.name)) && spec.widget !== 'textarea')
  const primaryNames = candidates.slice(0, 4).map(spec => spec.name)
  const secondary = active.filter(spec => !primaryNames.includes(spec.name))
  const compactDurationNames = displayParams.filter(spec => presentationKey(spec.name) === 'duration'
    && spec.widget === 'slider' && Number.isInteger(spec.min) && Number.isInteger(spec.max)
    && (spec.step ?? 1) === 1 && spec.max! - spec.min! <= 20).map(spec => spec.name)
  const changedSecondary = secondary.filter(spec => values[spec.name] !== undefined
    && String(values[spec.name]) !== String(spec.default)).length
  return { displayParams, primaryNames, secondaryNames: secondary.map(spec => spec.name), compactDurationNames, changedSecondary }
}
