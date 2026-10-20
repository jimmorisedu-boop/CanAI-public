import type { CatalogModel, ParamSpec } from '../../types'
import { AUTO_BY_REF_PARAMS, autoMeansUnset, isAspectParam } from '../canvas/autoParam'
import { panelParams } from '../canvas/genOptions'
import { aspectForRefs } from '../canvas/modelAspect'

/**
 * Пропорции ноды и «авто по референсу».
 *
 * ⚠️ Жалоба 01.10.2026 со снимком: «в ноде пропало авто пропорции». За ней
 * стояли три дефекта разом.
 *
 * 1. Панель ноды строилась без признака «референс подключён», и вариант «Авто»
 *    вырезался из списка всегда (`panelParams(eff)` — признак там по умолчанию
 *    «нет»). На локальном макросе в данных ноды при этом лежало 'auto': список
 *    показывал первый пункт, а в генерацию уходило другое.
 * 2. Правило срабатывало на КАЖДУЮ смену пропорции: стоило при подключённом
 *    референсе выбрать 16:9 — оно тут же возвращало 'auto'. Конкретную
 *    пропорцию задать было нельзя вовсе.
 * 3. В макросе сетевой доски параметр зовётся `aspect` (каталог сервера
 *    команды), а правило знало только `aspect_ratio` — и там не делало ничего:
 *    нода оставалась на 4:3 при любом референсе.
 *
 * Правило теперь то же, что у холста: «Авто» включается на ПЕРЕХОДЕ — появился
 * или пропал референс, сменилась модель, — а выбор человека между переходами
 * не трогается.
 *
 * ⚠️ Переход — это действие человека в редакторе. Три вещи выглядят так же, но
 * переходом НЕ являются, и писать на них нельзя ничего:
 *   • открыли редактор (параметры ноды сохранены в макросе: навязать тут своё
 *     значило бы менять макрос уже тем, что на него посмотрели, — он сразу
 *     становился «с правками», а у макроса сетевой доски менялся и результат);
 *   • Ctrl+Z и возврат вернули прежний снимок графа — запись поверх него
 *     стирала выбор человека и сжигала «повтор»;
 *   • граф перечитали с сервера после конфликта версий.
 * Все три — «первое знакомство»: память перехода начинается заново.
 */
export interface NodeAspectSeen {
  modelId: string
  hasMediaRefs: boolean
}

/** «Авто» у размера и разрешения без референса — то же обещание, что у пропорций. */
function concreteWithoutRefs(model: CatalogModel, params: Record<string, unknown>): Record<string, unknown> {
  let next = params
  for (const spec of model.params) {
    if (!AUTO_BY_REF_PARAMS.includes(spec.name) || isAspectParam(spec.name)) continue
    if (next[spec.name] !== 'auto' || autoMeansUnset(spec)) continue
    const concrete = spec.default !== undefined && spec.default !== 'auto'
      ? spec.default
      : spec.options?.find((option) => option.value !== 'auto')?.value
    if (concrete !== undefined) next = { ...next, [spec.name]: concrete }
  }
  return next
}

const AUTO_OPTION = { value: 'auto', label: 'Auto' }

/**
 * Модель глазами ноды: с референсом «Авто» есть и там, где сервер команды
 * пометил его `autoWithRefs`.
 *
 * ⚠️ Жалоба 19.10.2026 «куда пропало авто?»: у Grok Image HQ форма сетевой
 * доски строилась по операции без референса, где «Авто» нет, и нода с двумя
 * референсами его не показывала — хотя сервер его принимает (fal сохраняет
 * пропорции первой картинки). В сам список сервер его не кладёт: промпт-бар
 * показал бы «Авто» и без референса. Прежний сервер пометки не шлёт — тогда
 * всё как раньше.
 */
function withRefAuto(model: CatalogModel, hasMediaRefs: boolean): CatalogModel {
  if (!hasMediaRefs || !model.params.some((spec) => spec.autoWithRefs)) return model
  return {
    ...model,
    params: model.params.map((spec) => spec.autoWithRefs && spec.options
      && !spec.options.some((option) => option.value === 'auto')
      ? { ...spec, options: [AUTO_OPTION, ...spec.options] }
      : spec),
  }
}

/** Правило для заданного «референс есть / нет»; та же ссылка, если менять нечего. */
function settle(model: CatalogModel, params: Record<string, unknown>, hasMediaRefs: boolean): Record<string, unknown> {
  const next = aspectForRefs(withRefAuto(model, hasMediaRefs), params, hasMediaRefs)
  return hasMediaRefs ? next : concreteWithoutRefs(model, next)
}

export function nodeAspectStep(
  model: CatalogModel,
  params: Record<string, unknown>,
  seen: NodeAspectSeen | null,
  hasMediaRefs: boolean,
): Record<string, unknown> {
  if (!seen) return params
  if (seen.hasMediaRefs === hasMediaRefs && seen.modelId === model.id) return params
  return settle(model, params, hasMediaRefs)
}

/**
 * Параметры НОВОЙ ноды. Референса у неё быть не может, поэтому «Авто» из
 * умолчаний каталога сразу становится конкретным значением: иначе список
 * показывал бы первый пункт, а в макросе лежало бы 'auto'.
 */
export function settleNodeSeed(model: CatalogModel, seeded: Record<string, unknown>): Record<string, unknown> {
  return settle(model, seeded, false)
}

/**
 * Память перехода одной ноды. Живёт в чистом модуле, а не в компоненте, чтобы
 * её можно было проверить последовательностью шагов: тест, который читает
 * текст компонента, не замечал ни пропавшей записи памяти, ни записи ДО шага.
 *
 * `stamp` — отметка программной замены графа (её ставят отмена, возврат и
 * загрузка в useNodesGraph): сменилась — память начинается заново.
 */
export function createNodeAspectTracker() {
  let seen: NodeAspectSeen | null = null
  let stampSeen: number | undefined
  // Был ли референс, когда нода впервые показалась без каталога моделей.
  let refsBeforeModel: boolean | null = null
  return (
    model: CatalogModel | null,
    params: Record<string, unknown>,
    hasMediaRefs: boolean,
    stamp?: number,
  ): Record<string, unknown> => {
    if (stamp !== stampSeen) {
      stampSeen = stamp
      seen = null
      refsBeforeModel = null
    }
    if (!model) {
      // Каталог ещё едет. Запоминаем ПЕРВОЕ значение: референс, подключённый
      // за это время, — действие человека, а не то, что лежало в макросе.
      if (refsBeforeModel === null) refsBeforeModel = hasMediaRefs
      return params
    }
    const prior = seen
      ?? (refsBeforeModel !== null && refsBeforeModel !== hasMediaRefs
        ? { modelId: model.id, hasMediaRefs: refsBeforeModel }
        : null)
    const next = nodeAspectStep(model, params, prior, hasMediaRefs)
    seen = { modelId: model.id, hasMediaRefs }
    refsBeforeModel = null
    return next
  }
}

/**
 * Список параметров для панели ноды.
 *
 * ⚠️ Список не имеет права врать. Без референса «Авто» из него убирается — но
 * если в данных ноды уже лежит 'auto' (макрос сохранён так давно), пункт
 * остаётся: иначе список показал бы первый пункт, а в генерацию ушло бы другое.
 */
export function nodePanelParams(
  model: CatalogModel | null,
  params: Record<string, unknown>,
  hasMediaRefs: boolean,
): ParamSpec[] {
  if (!model) return []
  const panel = panelParams(withRefAuto(model, hasMediaRefs), hasMediaRefs)
  if (hasMediaRefs) return panel.map((spec) => withSavedValue(spec, params[spec.name]))
  return panel.map((spec) => {
    if (params[spec.name] !== 'auto' || spec.options?.some((option) => option.value === 'auto')) {
      return withSavedValue(spec, params[spec.name])
    }
    return withSavedValue(model.params.find((original) => original.name === spec.name) ?? spec, params[spec.name])
  })
}

/**
 * Сохранённое значение, которого в списке больше нет, показываем как есть.
 *
 * ⚠️ 19.10.2026 у Grok Image сетевой доски из списка размеров убраны «Small»
 * и «4K» — fal их не умеет, а сервер молча отдавал 1k и 2k. Макрос, сохранённый
 * с «4K», без этого правила показывал бы первый пункт, а в запуск уходило бы
 * «4K» — и сервер отказывал бы. Видно значение — видно, что его надо сменить.
 * Само значение не трогаем: открыть редактор — не действие над макросом.
 */
function withSavedValue(spec: ParamSpec, value: unknown): ParamSpec {
  if (spec.widget !== 'select' || !spec.options) return spec
  if (typeof value !== 'string' && typeof value !== 'number') return spec
  const saved = String(value)
  if (saved === '' || spec.options.some((option) => option.value === saved)) return spec
  const label = saved === 'auto' ? AUTO_OPTION.label : saved
  return { ...spec, options: [...spec.options, { value: saved, label: `${label} (not supported)` }] }
}
