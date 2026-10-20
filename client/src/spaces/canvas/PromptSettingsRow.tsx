import { useId, useRef, useState } from 'react'
import type { CatalogModel, JobKind, ParamSpec, ProjectSource } from '../../types'
import { IconMinus, IconPlus } from '../../ui/icons'
import { ParamControls } from '../../ui/ParamControls'
import { acceptsGifFrame, baseModels } from './genOptions'
import { executorCompatibilityError } from '../../../../packages/model-catalog/version'
import { autoOptionLabel } from './smartModelMessages'
import { AUTO_MODEL_ID, isAutoModelId } from './smartModelSelection'
import { promptParamPresentation } from './promptParamPresentation'

const MAX_COUNT = 4

// Нижний ряд промпт-бара: модель, количество вариантов, параметры модели и
// примерная цена. Вынесен из PromptBar — это отдельный экран настроек запуска,
// а не часть логики самого запуска.
export function PromptSettingsRow({
  models,
  kind,
  modelId,
  onModelChange,
  count,
  onCountChange,
  panel,
  params,
  onParamsChange,
  layout = 'inline',
  hasGifRef = false,
  autoEnabled = false,
  autoModelName = null,
  modelTitle,
}: {
  models: CatalogModel[]
  kind: JobKind
  modelId: string | null
  onModelChange(id: string): void
  count: number
  onCountChange(next: number): void
  panel: ParamSpec[]
  params: Record<string, unknown>
  onParamsChange(next: Record<string, unknown>): void
  hasMediaRefs: boolean
  imageReferenceCount: number
  hasGifRef?: boolean
  projectSource?: ProjectSource
  layout?: 'inline' | 'stacked'
  /** Док: список начинается с пункта «Авто». */
  autoEnabled?: boolean
  /** Имя базовой модели, которую «Авто» берёт сейчас; null — подобрать не из чего. */
  autoModelName?: string | null
  /** Подсказка списка: полное имя запускаемой модели либо причина отказа. */
  modelTitle?: string
}) {
  const inline = layout === 'inline'
  const presentation = promptParamPresentation(panel, params)
  const isText = (name: string) => presentation.displayParams.some(spec => spec.name === name && spec.widget === 'textarea')
  const secondaryTexts = presentation.secondaryNames.filter(isText)
  const secondaryPills = presentation.secondaryNames.filter(name => !isText(name))
  const [expanded, setExpanded] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const advancedId = useId()
  const autoSelected = autoEnabled && isAutoModelId(modelId)
  const selectedValue = autoSelected ? AUTO_MODEL_ID : modelId ?? ''
  // Подпись короткая намеренно: список моделей — единственный, кто уступает
  // место в ряду, и длинное «Авто · модель — вариант · цена» выталкивало бы
  // параметры за край. Полное имя — в подсказке, цена — на кнопке.
  const autoModelLabel = autoOptionLabel({
    selected: autoSelected,
    modelName: autoModelName,
    catalogReady: models.length > 0,
  })
  return (
    <div
      className={`gen-controls-secondary ${inline ? 'is-inline' : 'is-stacked'}`}
      onKeyDownCapture={event => {
        if (event.key === 'Escape' && expanded) {
          event.stopPropagation()
          event.preventDefault()
          setExpanded(false)
          moreRef.current?.focus()
        }
      }}
    >
      <select
        className="gen-select"
        title={modelTitle || "Model"}
        aria-label="Generation model"
        value={selectedValue}
        onChange={(event) => onModelChange(event.target.value)}
      >
        {autoEnabled && <option value={AUTO_MODEL_ID}>{autoModelLabel}</option>}
        {modelId && !isAutoModelId(modelId) && !baseModels(models, kind).some(model => model.id === modelId) && <option value={modelId} disabled>{models.find(model => model.id === modelId)?.name ?? modelId} · saved choice</option>}
        {baseModels(models, kind).map((model) => (
          <option key={model.id} value={model.id} disabled={Boolean(executorCompatibilityError(model)) || (hasGifRef && !acceptsGifFrame(models, kind, model.id))}>
            {model.name}{executorCompatibilityError(model) ? " · update CanAI" : hasGifRef && !acceptsGifFrame(models, kind, model.id) ? " · no image reference" : ''}
          </option>
        ))}
      </select>

      {kind === 'image' && (
        <div className="gen-count" title="Number of variants">
          <button
            type="button"
            className="icon-btn"
            aria-label="Decrease variants"
            disabled={count <= 1}
            onClick={() => onCountChange(Math.max(1, count - 1))}
          >
            <IconMinus size={14} />
          </button>
          <span>{count}×</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Increase variants"
            disabled={count >= MAX_COUNT}
            onClick={() => onCountChange(Math.min(MAX_COUNT, count + 1))}
          >
            <IconPlus size={14} />
          </button>
        </div>
      )}

      {presentation.primaryNames.length > 0 && (
        <ParamControls
          compact
          compactLabels
          compactSliderSelectNames={presentation.compactDurationNames}
          params={presentation.displayParams}
          visibleNames={presentation.primaryNames}
          values={params}
          onChange={onParamsChange}
        />
      )}
      {presentation.secondaryNames.length > 0 && (
        <button
          ref={moreRef}
          type="button"
          className="gen-params-more"
          aria-expanded={expanded}
          aria-controls={advancedId}
          title="Additional model parameters"
          onClick={() => setExpanded(value => !value)}
        >
          More{presentation.changedSecondary > 0 && <span className="gen-params-changed" title="Changed additional parameters">{presentation.changedSecondary}</span>}
        </button>
      )}
      {presentation.secondaryNames.length > 0 && expanded && (
        <div id={advancedId} className="gen-params-expanded" role="group" aria-label="Additional model parameters">
          {/* ⚠️ Теми же пилюлями, что и ряд над ними: раньше «More» раскрывал
              форму «подпись + широкий список» в две колонки, и вёрстка
              промпт-бара слетала (жалоба 19.10.2026 со снимком). Текстовые
              параметры (negative prompt, описание) остаются многострочным
              полем с «Развернуть» ниже пилюль: в пилюле фраза не помещается. */}
          {secondaryPills.length > 0 && (
            <ParamControls
              compact
              compactLabels
              compactSliderSelectNames={presentation.compactDurationNames}
              params={presentation.displayParams}
              visibleNames={secondaryPills}
              values={params}
              onChange={onParamsChange}
            />
          )}
          {secondaryTexts.length > 0 && (
            <ParamControls
              params={presentation.displayParams}
              visibleNames={secondaryTexts}
              values={params}
              onChange={onParamsChange}
            />
          )}
        </div>
      )}
    </div>
  )
}
