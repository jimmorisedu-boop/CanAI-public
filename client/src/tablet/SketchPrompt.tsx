import { useEffect, useState } from 'react'
import { InlineNotice } from '../ui/InlineNotice'
import { baseModels, useCatalogModels } from '../spaces/canvas/genOptions'
import { estimateGenerationCost } from '../spaces/canvas/generationEstimate'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import { materializeModelParams } from '../spaces/canvas/modelParamContract'
import { useModelSelection } from '../spaces/canvas/useModelSelection'
import { useTabletGeneration } from './useTabletGeneration'
import type { ProjectSource } from '../types'
import { tabletSystemMessage } from './tabletSystemMessage'
import { useT } from '../i18n/context.js'


// Промпт внутри режима скетча.
//
// Свой, а не общий док: в полноэкранном режиме дока не видно, а «дорисуй по
// наброску» — это и есть то, ради чего скетч открывают. Референс здесь один и
// он предопределён: склейка картинки с рисунком.

export function SketchPrompt({
  store,
  projectId,
  projectSource,
  itemId,
  onDirtyChange,
}: {
  store: CanvasStore
  projectId: string
  projectSource: ProjectSource
  itemId: string
  onDirtyChange?(dirty: boolean): void
}) {
  const t = useT()
  const [prompt, setPrompt] = useState('')
  useEffect(() => onDirtyChange?.(prompt.length > 0), [prompt, onDirtyChange])
  const { models } = useCatalogModels()
  const { modelId, params, effModel, chooseModel } = useModelSelection({
    models,
    kind: 'image',
    // Скетч всегда идёт референсом, поэтому модель сразу берётся её
    // ref-вариант — как на компьютере.
    hasRefsForModel: true,
    hasVideoRef: false,
    hasMediaRefs: true,
    mediaRefKey: itemId,
  })
  const { launch, error, setError, busy } = useTabletGeneration(store, projectId, true, projectSource)

  const picked = materializeModelParams(effModel, params, { hasMediaRefs: true })
  const price = estimateGenerationCost(effModel, picked, 1, 1)

  return (
    <>
      {error && (
        <InlineNotice className="tablet-error" tone="error" title={tabletSystemMessage(error, t('Could not start generation'))} onDismiss={() => setError(null)} />
      )}
      <select
        className="ui-field tablet-sketch-model"
        aria-label={t('Model')}
        value={modelId ?? ''}
        onChange={(event) => chooseModel(event.target.value)}
      >
        {baseModels(models, 'image').map((model) => (
          <option key={model.id} value={model.id}>{model.name}</option>
        ))}
      </select>
      <input
        className="ui-field tablet-sketch-input"
        aria-label={t('What to add from the sketch')}
        placeholder={t('What should be added from the sketch?')}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <button
        type="button"
        className="ui-btn primary"
        disabled={busy}
        onClick={() => {
          void launch({
            kind: 'image',
            prompt,
            refs: [],
            count: 1,
            params,
            // Модель здесь выбрана явно и набор предопределён (одна склейка):
            // запускается её вариант по референсам, а на карточку идёт она сама.
            selectModel: () => ({
              model: effModel,
              baseModel: models.find((model) => model.id === modelId) ?? null,
              error: null,
            }),
            sketchTarget: itemId,
          }).then((ok) => {
            if (ok) setPrompt('')
          })
        }}
      >
        {t('Create')} {price != null && <em className="tablet-price">${price.toFixed(2)}</em>}
      </button>
    </>
  )
}
