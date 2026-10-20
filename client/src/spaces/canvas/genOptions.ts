import { useEffect, useState } from 'react'
import { AUTO_BY_REF_PARAMS, autoMeansUnset } from './autoParam'
import { effectiveModel } from './effectiveModel'
import { api } from '../../api'
import type { CatalogDefaults, CatalogModel, JobKind, ParamSpec, ProjectSource } from '../../types'

// Опции генерации промпт-бара (как в Krea/Mixboard: модель и размер прямо у
// поля ввода). Каталог грузится один раз на сессию.

type CatalogSnapshot = { models: CatalogModel[]; defaults?: CatalogDefaults }
const cache: Record<ProjectSource, CatalogSnapshot | null> = { local: null, cloud: null }
const pending: Record<ProjectSource, Promise<CatalogSnapshot> | null> = { local: null, cloud: null }
const catalogListeners = new Set<() => void>()
export function notifyCatalogChanged(): void {
  cache.local = cache.cloud = null
  pending.local = pending.cloud = null
  for (const listener of catalogListeners) listener()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('canai:catalog-changed'))
}

// Ошибка загрузки каталога больше не глотается: раньше дропдаун моделей просто
// оставался пустым без объяснения. Теперь бар показывает плашку с «Повторить».
export function useCatalogModels(projectSource: ProjectSource = 'local'): {
  models: CatalogModel[]
  defaults?: CatalogDefaults
  catalogError: boolean
  retryCatalog: () => void
} {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot>(cache[projectSource] ?? { models: [] })
  const [catalogError, setCatalogError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const refresh = () => setAttempt(value => value + 1)
    catalogListeners.add(refresh)
    return () => { catalogListeners.delete(refresh) }
  }, [])

  useEffect(() => {
    if (cache[projectSource]) {
      setSnapshot(cache[projectSource] ?? { models: [] })
      setCatalogError(false)
      return
    }
    let alive = true
    const request = pending[projectSource] ??= (api.models()).then((r) => {
      // ⚠️ У сетевого каталога цена приходит плоскими полями, и без перевода
      // она пропадает с кнопки, а порог дорогой генерации не срабатывает.
      const models = r.models
      const localResponse = r as { models: CatalogModel[]; defaults?: CatalogDefaults }
      const next = {
        models,
        defaults: projectSource === 'local' ? localResponse.defaults : undefined,
      }
      cache[projectSource] = next
      return next
    })
    request
      .then((next) => {
        if (!alive) return
        setSnapshot(next)
        setCatalogError(false)
      })
      .catch(() => {
        if (!alive) return
        pending[projectSource] = null // сброс, чтобы «Повторить» запросил заново
        setCatalogError(true)
      })
    return () => {
      alive = false
    }
  }, [attempt, projectSource])

  return {
    models: snapshot.models,
    defaults: snapshot.defaults,
    catalogError,
    retryCatalog: () => setAttempt((a) => a + 1),
  }
}

// Какая модель реально отработает — в effectiveModel.ts (чистый модуль: его
// сверяет со своим сервером server/src/imageRefVariant.test.ts).
export { effectiveModel }

/** A GIF is sent as a still PNG frame, so only models with image input qualify. */
export function acceptsImageReference(model: CatalogModel | null): boolean {
  if (!model || model.maxImageRefs === 0 || model.maxTotalRefs === 0) return false
  return Boolean(
    model.refs
    || model.imageInputField
    || (model.maxImageRefs ?? 0) > 0
    || model.inputModalities?.includes('image'),
  )
}

export function acceptsGifFrame(models: CatalogModel[], kind: JobKind, modelId: string): boolean {
  return acceptsImageReference(effectiveModel(models, kind, modelId, true))
}

// Базовые модели для дропдауна (ref-варианты включаются сами по рефам, если
// есть пара; самостоятельные модели с refs: true вроде Ideogram Character Edit
// — показываем явно). Канвас — курированный короткий список, поэтому по
// умолчанию модели с canvasHidden (не вписываются в курирование, но нужны в
// нодах для гибкости) отфильтрованы; ноды зовут с includeHidden=true.
export function baseModels(
  models: CatalogModel[],
  kind: JobKind,
  includeHidden = false,
): CatalogModel[] {
  const pairedRefIds = new Set<string>()
  for (const m of models) {
    if (m.pairId) pairedRefIds.add(m.pairId)
    if (m.videoPairId) pairedRefIds.add(m.videoPairId)
  }
  return models.filter(
    (m) =>
      m.kind === kind &&
      (!m.lifecycle || m.lifecycle === 'active') &&
      (!m.refs || !pairedRefIds.has(m.id)) &&
      (includeHidden || !m.canvasHidden),
  )
}

// Параметры модели для панели настроек на канвасе. num_images НЕ показываем:
// на канвасе количеством управляет счётчик «×N» (несколько параллельных задач,
// сервер отдаёт по одному результату на задачу — см. PromptBar).
// Обычно «Авто»-пропорция доступна только при наличии медиа-референса. У
// десктопного промпта есть явное исключение: там «Авто» — стартовый выбор
// сессионной памяти пользователя.
/**
 * ⚠️ «Авто» означает «решает модель ПО РЕФЕРЕНСУ». Без референса решать не по
 * чему, и выбор превращается в обещание, которого никто не выполнит: сервер
 * молча подставит своё значение. Поэтому без референса вариант убираем — у
 * ЛЮБОГО параметра, где он есть.
 *
 * ⚠️ Раньше проверялось имя `aspect_ratio`, и это ломалось на командной доске:
 * там каталог свой, и параметр зовётся `aspect` (а размер — `size` вместо
 * `image_size`/`resolution`). Имя параметра — не наш контракт, его задаёт
 * сторона, чей каталог; поэтому смотрим на СОДЕРЖИМОЕ, а не на название.
 */
function withoutAuto(param: ParamSpec): ParamSpec {
  // У подключённой модели auto может означать режим, язык или алгоритм;
  // его смысл задаёт её схема и он не зависит от наличия референса.
  if (!AUTO_BY_REF_PARAMS.includes(param.name)) return param
  if (!param.options?.some((opt) => opt.value === 'auto')) return param
  // У канона сервера команды такой «Авто» — «параметр не задан», а не обещание
  // решить по референсу: его выполняет сам сервер, и вырезать его нельзя.
  if (autoMeansUnset(param)) return param
  const options = param.options.filter((opt) => opt.value !== 'auto')
  return {
    ...param,
    default: param.default !== 'auto' ? param.default : (options[0]?.value ?? '1:1'),
    options,
  }
}

function withDesktopAutoDefault(param: ParamSpec): ParamSpec {
  if (!['aspect', 'aspect_ratio'].includes(param.name)) return param
  if (!param.options?.some((option) => option.value === 'auto')) return param
  return param.default === 'auto' ? param : { ...param, default: 'auto' }
}

export function supportsVirtualAspectAuto(param: ParamSpec | undefined, enabled: boolean): boolean {
  return Boolean(enabled && param && ['aspect', 'aspect_ratio'].includes(param.name)
    && param.widget === 'select' && param.options?.length
    && !param.options.some(option => option.value === 'auto')
    && param.options.some(option => parseRatio(option.value) !== null))
}

export function panelParams(
  model: CatalogModel | null,
  hasMediaRefs = false,
  allowAutoWithoutRefs = false,
  allowVirtualAspectAuto = false,
): ParamSpec[] {
  if (!model) return []
  return model.params
    .filter((p) => p.name !== 'num_images')
    .map((p) => {
      const visible = supportsVirtualAspectAuto(p, allowVirtualAspectAuto && hasMediaRefs)
        ? { ...p, default: 'auto', options: [{ value: 'auto', label: "Auto" }, ...p.options!] }
        : p
      return allowAutoWithoutRefs
        ? withDesktopAutoDefault(visible)
        : hasMediaRefs ? visible : withoutAuto(visible)
    })
}

// «W:H» строка → число (ширина/высота); null, если не распознали
function parseRatio(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? w / h : null
}

// Пропорции результата ДО генерации — по выбранным настройкам модели
// (aspect_ratio); «Авто» означает «под референс» — тогда берём его пропорции
// (fallback). Нужно, чтобы карточка-заглушка сразу встала того же размера,
// что и будущий результат, а не всегда квадратом.
export function estimatedAspectRatio(
  model: CatalogModel | null,
  params: Record<string, unknown>,
  fallback: number | null,
): number {
  // Локальный каталог использует aspect_ratio, сетевой — канонический aspect.
  const spec = model?.params.find((param) => param.name === 'aspect_ratio' || param.name === 'aspect')
  const raw = spec ? params[spec.name] ?? spec.default : params.aspect_ratio ?? params.aspect
  if (raw === 'auto') return fallback ?? 1
  if (typeof raw === 'string') {
    const parsed = parseRatio(raw)
    if (parsed) return parsed
  }
  return fallback ?? 1
}

/**
 * Имя модели по её id — БЕЗ подписки на каталог.
 *
 * ⚠️ Строка сведений рисуется у каждой фигуры на холсте, а подписка внутри
 * фигуры однажды уже стоила 246 мс на один сдвиг камеры (см. cameraScale.ts).
 * Каталог загружается один раз при старте и дальше не меняется, поэтому здесь
 * достаточно снимка: пусто — просто покажем имя файла.
 */
export function modelDisplayName(modelId: string | undefined): string {
  if (!modelId) return ''
  for (const snapshot of [cache.local, cache.cloud]) {
    const found = snapshot?.models.find((model) => model.id === modelId)
    if (found?.name) return found.name
  }
  return ''
}
