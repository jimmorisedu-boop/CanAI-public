import type { ParamSpec } from '../types'
import { IconDice } from './icons'
import { ExpandableTextarea } from './ExpandableTextarea'
import { parameterActive, changeParameter } from '../../../packages/model-catalog/parameterRules'

// Рендер настроек модели по её схеме параметров (подход WaveSpeed FormField:
// виджет выбирается по описанию поля). Компактно — только нужные типы.
// Общий компонент: используется и на ноде, и в промпт-баре канваса.

type Values = Record<string, unknown>

function randomSeed(): number {
  // без Math.random в скрипте нельзя, но здесь клиент — можно
  return Math.floor(Math.random() * 1_000_000)
}

// Текстовый параметр (системный промпт): в ноде компактно, но поле растёт под
// содержимое до потолка, а по кнопке открывается полноэкранный редактор —
// длинные тексты в колонке шириной 280px иначе нечитаемы. Само поле с кнопкой —
// общий ExpandableTextarea (он же у промптов нод).
function TextareaField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec
  value: unknown
  onChange: (v: unknown) => void
}) {
  return (
    <ExpandableTextarea
      label={spec.label}
      value={String(value ?? spec.default ?? '')}
      onChange={onChange}
      rows={3}
      className="param-input nodrag nowheel"
      wrapClassName="param-textarea"
      autoGrow
    />
  )
}

function Field({
  spec,
  value,
  onChange,
  compact,
  compactSliderSelect,
  dense,
}: {
  spec: ParamSpec
  value: unknown
  onChange: (v: unknown) => void
  compact?: boolean
  compactSliderSelect?: boolean
  dense?: boolean
}) {
  const common = { className: 'param-input nodrag', 'aria-label': spec.label, onKeyDownCapture: (e: React.KeyboardEvent) => e.stopPropagation() }

  if (spec.widget === 'select') {
    return (
      <select {...common} value={String(value ?? spec.default ?? '')} onChange={(e) => onChange(e.target.value)}>
        {spec.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }

  if (spec.widget === 'boolean') {
    return (
      <input
        type="checkbox"
        className="param-checkbox nodrag"
        aria-label={spec.label}
        checked={Boolean(value ?? spec.default)}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  }

  if (spec.widget === 'textarea') {
    // В компактном ряду промпт-бара многострочное поле не помещается: оно
    // тянет за собой 58px высоты и кнопку «Развернуть», из-за чего ряд пилюль
    // ломался, а значение вываливалось поверх соседних кнопок. Там, где места
    // хватает (панель ноды), остаётся полноценный редактор.
    if (compact) {
      return (
        <input
          {...common}
          type="text"
          value={String(value ?? spec.default ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    }
    return <TextareaField spec={spec} value={value} onChange={onChange} />
  }

  if (spec.widget === 'slider') {
    const num = Number(value ?? spec.default ?? spec.min ?? 0)
    if (compactSliderSelect && spec.min != null && spec.max != null) {
      const step = spec.step ?? 1
      const optionCount = Math.floor((spec.max - spec.min) / step) + 1
      const options = Array.from({ length: optionCount }, (_, index) => spec.min! + index * step)
      return (
        <select
          {...common}
          aria-label={spec.label}
          value={String(num)}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {options.map((option) => (
            <option key={option} value={option}>{option} sec</option>
          ))}
        </select>
      )
    }
    return (
      <div className="param-slider">
        <input
          type="range"
          className="nodrag"
          aria-label={spec.label}
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          value={num}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="param-slider-value">{num}</span>
      </div>
    )
  }

  if (spec.widget === 'seed') {
    return (
      <div className="param-seed">
        <input
          {...common}
          type="number"
          style={dense ? { width: 54 } : undefined}
          value={Number(value ?? spec.default ?? -1)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button className="param-dice nodrag icon-btn" title="Random seed" onClick={() => onChange(randomSeed())}>
          <IconDice size={15} />
        </button>
      </div>
    )
  }

  // number
  return (
    <input
      {...common}
      type="number"
      min={spec.min}
      max={spec.max}
      step={spec.step ?? 1}
      value={Number(value ?? spec.default ?? 0)}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

export function ParamControls({
  params,
  values,
  onChange,
  compact,
  comfortable,
  singleLine,
  compactSliderSelect,
  compactSliderSelectNames,
  dense,
  compactLabels,
  visibleNames,
}: {
  params: ParamSpec[]
  values: Values
  onChange: (next: Values) => void
  // compact — горизонтальный ряд «пилюль» прямо в баре (у select значение
  // самоописательно, поэтому подпись прячем, полное имя — в подсказке)
  compact?: boolean
  // comfortable — просторная планшетная раскладка: сохраняет компактные
  // виджеты, но возвращает постоянные подписи и крупные touch targets.
  comfortable?: boolean
  // Десктопный промпт-бар держит модель и все параметры в одном ряду.
  singleLine?: boolean
  // У MiniMax H3 длинный слайдер длительности заменяется коротким списком,
  // но наружу по-прежнему отдаётся число — так требует схема fal.
  compactSliderSelect?: boolean
  // Only named compact sliders become selects; unrelated sliders stay sliders.
  compactSliderSelectNames?: string[]
  // Плотный ряд для моделей с большим набором параметров.
  dense?: boolean
  /** Orders and filters rendering; dependency rules still use the entire schema. */
  visibleNames?: readonly string[]
  compactLabels?: boolean
}) {
  if (params.length === 0) return null
  const visibleParams = visibleNames
    ? visibleNames.flatMap(name => params.filter(spec => spec.name === name))
    : params
  return (
    <div
      className={`param-controls${compact ? ' compact' : ''}${comfortable ? ' comfortable' : ''}${compactLabels ? ' labelled' : ''}`}
      style={singleLine ? { flexWrap: 'nowrap', ...(dense ? { gap: 4 } : {}) } : undefined}
    >
      {visibleParams.map((spec) => {
        if (!parameterActive(spec, params, values)) return null
        const sliderIsSelect = spec.widget === 'slider'
          && (compactSliderSelect || compactSliderSelectNames?.includes(spec.name))
        const hideLabel = compact && !comfortable && !compactLabels && (spec.widget === 'select' || sliderIsSelect)
        const visibleLabel = dense && spec.name === 'enable_safety_checker' ? 'Filter' : spec.label
        // текст занимает всю ширину: подпись сверху, поле под ней — в две
        // колонки длинному промпту оставалась половина и без того узкой ноды
        const wide = !compact && spec.widget === 'textarea'
        return (
          <label
            className={`param-row widget-${spec.widget}${wide ? ' wide' : ''}`}
            key={spec.name}
            data-param-name={spec.name}
            title={compact ? (spec.widget === 'seed' ? 'Seed: -1 = random' : spec.label) : undefined}
          >
            {!hideLabel && <span className="param-label">{visibleLabel}</span>}
            <Field
              spec={spec}
              value={values[spec.name]}
              onChange={(v) => onChange(changeParameter(params, values, spec.name, v))}
              compact={compact}
              compactSliderSelect={sliderIsSelect}
              dense={dense}
            />
          </label>
        )
      })}
    </div>
  )
}

// начальные значения из дефолтов схемы (засев при выборе модели)
export function seedDefaults(params: ParamSpec[]): Values {
  const out: Values = {}
  for (const p of params) if (p.default !== undefined) out[p.name] = p.default
  return out
}
