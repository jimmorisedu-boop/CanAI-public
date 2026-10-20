import type { CatalogDefaults, CatalogModel, JobKind } from '../../types'
import { reconcileModelParams } from './modelParamContract'
import { selectSmartModel, type SmartModelRef } from './smartModelSelection'

// Что происходит с параметрами в миг выбора модели: из списка, при смене типа
// и при возврате черновика сеанса. Чистая функция — у хука остаётся только
// состояние.

export interface DockModelChoiceInput {
  models: readonly CatalogModel[]
  defaults?: CatalogDefaults
  /**
   * Тип, ПОД КОТОРЫЙ выбирают. ⚠️ У черновика сеанса он свой: возврат зовёт
   * смену типа и выбор модели подряд, и тип из замыкания хука к этому мигу ещё
   * прежний. «Авто» подбиралось по нему — параметры видео сверялись с моделью
   * картинок и терялись: длительность и разрешение молча сбрасывались на
   * умолчания, а это цена.
   */
  kind: JobKind
  /** Номер из списка либо «Авто». */
  modelId: string | null
  /** Что подбор увидит в запросе при этом типе. */
  refs: readonly SmartModelRef[]
  /** Память параметров по моделям (modelParamsStorage). */
  saved: Record<string, Record<string, unknown>>
  /** Параметры из черновика сеанса: они важнее памяти этого устройства. */
  restoredParams?: Record<string, unknown>
  options: { hasMediaRefs: boolean; allowAutoWithoutRefs: boolean }
}

export function chooseDockModel(input: DockModelChoiceInput): {
  model: CatalogModel | null
  params: Record<string, unknown>
} {
  const model = selectSmartModel({
    models: input.models,
    defaults: input.defaults,
    kind: input.kind,
    modelId: input.modelId,
    refs: input.refs,
  }).panelModel
  return { model, params: chosenModelParams(model, input.saved, input.restoredParams, input.options) }
}

/**
 * Параметры под выбранную модель: память устройства как основа, поверх —
 * присланные значения, и те и другие только для настоящих полей каталога.
 */
export function chosenModelParams(
  model: CatalogModel | null,
  saved: Record<string, Record<string, unknown>>,
  restoredParams: Record<string, unknown> | undefined,
  options: DockModelChoiceInput['options'],
): Record<string, unknown> {
  const remembered = reconcileModelParams(model, {}, model ? saved[model.id] ?? {} : {}, options)
  const restored = restoredParams ? reconcileModelParams(model, {}, restoredParams, options) : {}
  return { ...remembered, ...restored }
}
