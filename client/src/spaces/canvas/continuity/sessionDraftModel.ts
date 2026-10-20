import type { CatalogDefaults, CatalogModel, SessionDraft, SessionDraftRef } from '../../../types'
import type { SelectionRef } from '../konva/selection'
import { defaultModelId } from '../modelAspect'
import { AUTO_MODEL_ID, isAutoModelId, selectableModelId } from '../smartModelSelection'

// Перевод между тем, чем живёт промпт-бар, и тем, что уезжает на сервер.
// Чистые функции: их можно проверить без DOM, а весь риск переноса сеанса
// между устройствами сидит именно здесь.

/**
 * Референс промпт-бара → референс черновика.
 *
 * Наружу уходит только ссылка на файл в media. Всё остальное (base64,
 * внешний адрес, кадр, снятый из видео) — не ссылка на материал, а его копия,
 * и в состоянии приложения ей не место.
 */
export function refToDraftRef(ref: SelectionRef): SessionDraftRef | null {
  if (ref.kind === 'text') {
    const text = ref.text?.trim()
    return text ? { id: ref.shapeId, kind: 'text', text, name: ref.label } : null
  }
  const src = ref.src ?? ''
  // Локальная доска хранит media-ссылки напрямую, а командная — через
  // desktop-прокси или собственный /v3. Разрешаем только эти внутренние
  // формы: внешний URL и data URL не должны пережить границу устройства.
  const cloudAsset = /^\/(?:api\/cloud-assets|v3)\/assets\/ast_[A-Za-z0-9_-]{1,120}(?:[?#].*)?$/u.test(src)
  if (!src.startsWith('/media/') && !cloudAsset) return null
  return { id: ref.shapeId, kind: ref.kind, src, name: ref.label }
}

export function draftRefToRef(ref: SessionDraftRef): SelectionRef {
  return {
    shapeId: ref.id,
    kind: ref.kind,
    label: ref.name ?? (ref.kind === 'text' ? 'text' : 'file'),
    src: ref.src,
    text: ref.text,
  }
}

export interface PromptDraftState {
  prompt: string
  kind: SessionDraft['kind']
  modelId?: string | null
  params?: Record<string, unknown>
  count?: number
  pane?: SessionDraft['pane']
  selection?: readonly string[]
  manualRefs?: readonly SelectionRef[]
}

/** Собрать черновик из состояния промпт-бара. */
export function buildSessionDraft(state: PromptDraftState): SessionDraft {
  const draft: SessionDraft = { prompt: state.prompt, kind: state.kind }
  // «Авто» в черновик не пишется: это значение списка, а не номер модели, и в
  // сохранённых данных ему не место. Черновик без модели и означает «Авто».
  if (state.modelId && !isAutoModelId(state.modelId)) draft.modelId = state.modelId
  const params = cleanDraftParams(state.params)
  if (params) draft.params = params
  if (state.count && state.count > 1) draft.count = state.count
  if (state.pane) draft.pane = state.pane
  const selection = (state.selection ?? []).filter((id) => typeof id === 'string')
  if (selection.length > 0) draft.selection = [...selection]
  const refs = (state.manualRefs ?? [])
    .map(refToDraftRef)
    .filter((ref): ref is SessionDraftRef => ref !== null)
  if (refs.length > 0) draft.manualRefs = refs
  return draft
}

/** В черновик уезжают только примитивы — ровно то, что примет сервер. */
export function cleanDraftParams(
  params: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!params) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function sameDraft(a: SessionDraft, b: SessionDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Стоит ли показывать «продолжить с другого устройства».
 *
 * Черновик своего же устройства подсказкой не считаем: там всё и так на месте,
 * а лишняя карточка на каждом открытии доски — шум.
 */
export function isForeignDraft(draftDevice: string, thisDevice: string): boolean {
  return draftDevice.trim().toLowerCase() !== thisDevice.trim().toLowerCase()
}

/**
 * Можно ли применить черновик, не затирая работу.
 *
 * Единственное, чего нельзя делать никогда: подставить чужой промпт поверх
 * того, что человек уже набрал здесь. Пустое поле — можно.
 */
export function canApplyDraft(current: PromptDraftState): boolean {
  return current.prompt.trim() === '' && (current.manualRefs?.length ?? 0) === 0
}

/**
 * Настройки генерации можно вернуть отдельно от текста.
 *
 * На компьютере поле помощника может уже получить свой серверный черновик к
 * моменту, когда приезжает черновик промпт-бара. Такой текст нельзя затирать,
 * но модель и её параметры всё равно относятся к общей полке и должны
 * продолжить сеанс. Если тип генерации уже другой, модель от старого типа не
 * подставляем: переключение типа само меняет модель.
 */
export function canApplyDraftSettings(
  current: PromptDraftState,
  draft: Pick<SessionDraft, 'kind'>,
): boolean {
  return canApplyDraft(current) || current.kind === draft.kind
}

/** Что промпт-бар умеет вернуть из черновика. */
export interface PromptDraftApply {
  setPrompt(text: string): void
  /** Смена типа генерации целиком, как по нажатию чипа: она же подтягивает
   *  модель по умолчанию и сбрасывает счётчик — поэтому счётчик из черновика
   *  применяется ПОСЛЕ неё. */
  applyKind(kind: SessionDraft['kind']): void
  setCount(count: number): void
  /**
   * Модель вместе с её параметрами и ТИПОМ черновика. Тип обязателен по
   * смыслу: смена типа к этому вызову ещё не дошла до состояния, и без него
   * «Авто» подбиралось под прежний тип — параметры видео сверялись с моделью
   * картинок и терялись.
   */
  chooseModel(id: string, params: Record<string, unknown> | undefined, kind: SessionDraft['kind']): void
  setManualRefs(refs: SelectionRef[]): void
  setSelection(ids: string[]): void
}

/** Что черновику нужно знать о каталоге этого устройства. */
export interface DraftModelCatalog {
  /** Номер из списка по сохранённому: вариант переводится в базу; null — модели нет. */
  selectableId(modelId: string): string | null
  /** Модель по умолчанию для типа — та, что прежние версии писали в черновик сами. */
  defaultModelId(kind: SessionDraft['kind']): string | null
}

export function draftModelCatalog(
  models: readonly CatalogModel[],
  defaults?: CatalogDefaults,
): DraftModelCatalog {
  return {
    selectableId: (modelId) => selectableModelId(models, modelId),
    defaultModelId: (kind) => defaultModelId(models as CatalogModel[], kind, defaults),
  }
}

/**
 * Какую модель выбрать по черновику; null — оставить как есть.
 *
 * - Модели в черновике нет — это «Авто» (так его и пишут, см. buildSessionDraft).
 * - Модель равна модели по умолчанию — тоже «Авто». Прежние версии писали
 *   номер умолчания в КАЖДЫЙ черновик, хотя человек ничего не выбирал: без
 *   этого правила док на всех досках с черновиком открывался бы в ручном
 *   режиме. Потери нет: «Авто» берёт модель по умолчанию первой (на сетевой
 *   доске — первую не уходящую), а отступает от неё, только когда она не
 *   принимает выбранные референсы.
 * - Номер варианта («…-edit») переводится в базу: в списке его нет.
 * - Незнакомая модель (черновик другой версии) ничего не меняет, и её
 *   параметры не подставляются: они от модели, которой здесь нет.
 */
export function restoredDraftModel(
  draft: Pick<SessionDraft, 'kind' | 'modelId' | 'params'>,
  catalog: DraftModelCatalog,
): { modelId: string; params?: Record<string, unknown> } | null {
  if (!draft.modelId || isAutoModelId(draft.modelId)) {
    return { modelId: AUTO_MODEL_ID, params: draft.params }
  }
  const selectable = catalog.selectableId(draft.modelId)
  if (!selectable) return null
  if (selectable === catalog.defaultModelId(draft.kind)) {
    return { modelId: AUTO_MODEL_ID, params: draft.params }
  }
  return { modelId: selectable, params: draft.params }
}

/**
 * Вернуть черновик в промпт-бар. Порядок вызовов — часть правила: тип раньше
 * модели, счётчик после типа, выделение после ручных чипов.
 */
export function restoreSessionDraft(input: {
  draft: SessionDraft
  current: PromptDraftState
  target: PromptDraftApply
  catalog: DraftModelCatalog
}): void {
  const { draft, current, target, catalog } = input
  const model = restoredDraftModel(draft, catalog)
  if (!canApplyDraft(current)) {
    // Набранный здесь текст не трогаем, но модель и её ручки относятся к
    // общей полке и продолжают сеанс — если тип генерации тот же.
    if (model && canApplyDraftSettings(current, draft)) {
      target.chooseModel(model.modelId, model.params, draft.kind)
    }
    return
  }
  if (draft.kind) target.applyKind(draft.kind)
  if (model) target.chooseModel(model.modelId, model.params, draft.kind)
  if (draft.count && draft.count > 1) target.setCount(draft.count)
  if (draft.manualRefs?.length) target.setManualRefs(draft.manualRefs.map(draftRefToRef))
  // Выделение возвращаем последним: чипы референсов зеркалят его, и до
  // подстановки ручных чипов оно перетасовало бы их порядок.
  if (draft.selection?.length) target.setSelection([...draft.selection])
  if (draft.prompt) target.setPrompt(draft.prompt)
}
