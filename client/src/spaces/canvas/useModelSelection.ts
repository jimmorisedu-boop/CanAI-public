import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogDefaults, CatalogModel, JobKind } from '../../types'
import { effectiveModel } from './genOptions'
import {
  applyPromptAspectSession,
  aspectForRefs,
  defaultModelId,
  rememberPromptAspectSession,
} from './modelAspect'
import { chooseDockModel, chosenModelParams } from './modelChoice'
import { reconcileModelParams } from './modelParamContract'
import { loadSavedModelParams, saveModelParams } from './modelParamsStorage'
import {
  AUTO_MODEL_ID,
  isAutoModelId,
  selectSmartModel,
  type SmartModelRef,
} from './smartModelSelection'

// Выбор модели и её параметров: какая модель реально отработает, какие ручки
// показывать, что помнить между запусками и что делать с пропорциями при
// появлении референса. Отдельная область ответственности — в теле PromptBar
// она была размазана двумя эффектами, колбэком и функцией смены типа.
export function useModelSelection(input: {
  models: CatalogModel[]
  defaults?: CatalogDefaults
  kind: string
  // Прежний подбор без «Авто» (скетч на планшете): есть ли референс для модели.
  hasRefsForModel?: boolean
  hasVideoRef?: boolean
  // референс для параметров: то же, но без учёта видео-приоритета
  hasMediaRefs: boolean
  // состав медиа-референсов; его СМЕНА и переключает пропорции
  mediaRefKey: string
  // На десктопе пропорции начинаются с «Авто» и живут только текущую сессию.
  promptAspectSession?: boolean
  virtualAspectAuto?: boolean
  /**
   * Док: список моделей начинается с «Авто». Подбору нужны референсы ПЕРВОГО
   * запроса при данном типе генерации (dockLeadRefs) — по той же модели потом
   * строятся предпросмотр и запуск, поэтому ручки сверяются именно под неё.
   */
  smartAuto?: { refsFor(kind: JobKind): readonly SmartModelRef[] }
}) {
  const {
    models, defaults, kind, hasRefsForModel = false, hasVideoRef = false, hasMediaRefs, mediaRefKey,
    promptAspectSession = false, virtualAspectAuto = false,
    smartAuto,
  } = input
  const autoEnabled = Boolean(smartAuto)
  const [modelId, setModelId] = useState<string | null>(() => autoEnabled ? AUTO_MODEL_ID : null)
  const [params, setParams] = useState<Record<string, unknown>>({})
  const previousMediaRefKey = useRef(mediaRefKey)

  const smartSelection = smartAuto
    ? selectSmartModel({
        models,
        kind: kind as JobKind,
        refs: smartAuto.refsFor(kind as JobKind),
        modelId,
        defaults,
      })
    : null
  // При отказе «Авто» это модель по умолчанию: её ручки остаются на виду.
  const effModel = smartSelection
    ? smartSelection.panelModel
    : effectiveModel(models, kind as never, modelId, hasRefsForModel, hasVideoRef)
  const baseModelId = smartSelection?.baseModel?.id ?? null

  // каталог загрузился — ставим модель по умолчанию для текущего типа
  useEffect(() => {
    if (models.length > 0 && !modelId) setModelId(autoEnabled ? AUTO_MODEL_ID : defaultModelId(models, kind, defaults))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, defaults, autoEnabled])

  // сменилась модель — подтягиваем её запомненные настройки и правим пропорции
  useEffect(() => {
    if (!effModel?.id) return
    const saved = loadSavedModelParams()
    const savedForModel =
      saved[effModel.id] ?? (effModel.pairId ? saved[effModel.pairId] : undefined) ?? {}
    const options = {
      hasMediaRefs: promptAspectSession || hasMediaRefs,
      allowAutoWithoutRefs: promptAspectSession,
    }
    if (promptAspectSession) {
      saveModelParams(effModel.id, {}, ['aspect_ratio', 'aspect'])
      if (effModel.pairId) saveModelParams(effModel.pairId, {}, ['aspect_ratio', 'aspect'])
    }
    setParams((current) => {
      const reconciled = reconcileModelParams(effModel, current, savedForModel, options)
      return promptAspectSession
        ? applyPromptAspectSession(effModel, reconciled, virtualAspectAuto && hasMediaRefs)
        : aspectForRefs(effModel, reconciled, hasMediaRefs)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effModel?.id, hasMediaRefs])

  // сменился САМ НАБОР референсов — только тогда трогаем пропорции
  useEffect(() => {
    if (!promptAspectSession && mediaRefKey !== previousMediaRefKey.current) {
      setParams((current) => aspectForRefs(effModel, current, Boolean(mediaRefKey)))
    }
    previousMediaRefKey.current = mediaRefKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaRefKey, effModel, promptAspectSession])

  // значения запоминаются и под эффективной моделью, и под выбранной: ref-вариант
  // и её база должны делиться настройками
  const updateParams = useCallback(
    (
      next:
        | Record<string, unknown>
        | ((prev: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      setParams((prev) => {
        const value = typeof next === 'function' ? next(prev) : next
        if (promptAspectSession) rememberPromptAspectSession(effModel, value, virtualAspectAuto && hasMediaRefs)
        const transient = promptAspectSession ? ['aspect_ratio', 'aspect'] : []
        if (effModel?.id) {
          saveModelParams(effModel.id, value, transient)
          if (effModel.pairId) saveModelParams(effModel.pairId, value, transient)
        }
        // «Авто» номера в списке не держит — запоминаем под базой подобранной модели.
        const listedId = isAutoModelId(modelId) ? baseModelId : modelId
        if (listedId) saveModelParams(listedId, value, transient)
        return value
      })
    },
    [effModel, modelId, baseModelId, promptAspectSession, virtualAspectAuto, hasMediaRefs],
  )

  const paramOptions = {
    hasMediaRefs: promptAspectSession || hasMediaRefs,
    allowAutoWithoutRefs: promptAspectSession,
  }

  // Модель и её ручки в миг выбора. Тип передаётся ЯВНО: смена типа и возврат
  // черновика зовут выбор раньше, чем `kind` из замыкания успеет обновиться.
  const applyChoice = (
    id: string | null,
    targetKind: string,
    restoredParams?: Record<string, unknown>,
  ): void => {
    setModelId(id)
    const saved = loadSavedModelParams()
    const choice = smartAuto
      ? chooseDockModel({
          models,
          defaults,
          kind: targetKind as JobKind,
          modelId: id,
          refs: smartAuto.refsFor(targetKind as JobKind),
          saved,
          restoredParams,
          options: paramOptions,
        })
      : (() => {
          const model = models.find((item) => item.id === id) ?? null
          return { model, params: chosenModelParams(model, saved, restoredParams, paramOptions) }
        })()
    setParams(promptAspectSession
      ? applyPromptAspectSession(choice.model, choice.params, virtualAspectAuto && hasMediaRefs)
      : choice.params)
  }

  // выбор модели руками из списка; черновик сеанса приносит ещё параметры и
  // свой тип генерации
  const chooseModel = useCallback(
    (id: string, restoredParams?: Record<string, unknown>, restoredKind?: string) => {
      applyChoice(id, restoredKind ?? kind, restoredParams)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaults, kind, models, hasMediaRefs, promptAspectSession, smartAuto?.refsFor, virtualAspectAuto],
  )

  // смена типа генерации подтягивает модель по умолчанию и её настройки
  const resetForKind = useCallback(
    (nextKind: string) => {
      applyChoice(autoEnabled ? AUTO_MODEL_ID : defaultModelId(models, nextKind, defaults), nextKind)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autoEnabled, models, defaults, hasMediaRefs, promptAspectSession, smartAuto?.refsFor, virtualAspectAuto],
  )

  return {
    modelId,
    setModelId,
    params,
    effModel,
    updateParams,
    chooseModel,
    resetForKind,
  }
}
