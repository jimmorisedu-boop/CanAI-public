import type { CatalogDefaults, CatalogModel } from '../../types'
import { autoMeansUnset } from './autoParam'
import { baseModels, supportsVirtualAspectAuto } from './genOptions'
import { executorCompatibilityError } from '../../../../packages/model-catalog/version'

const PROMPT_ASPECT_SESSION_KEY = 'canai-prompt-aspect-session'
const ASPECT_PARAM_NAMES = new Set(['aspect_ratio', 'aspect'])
let promptAspectMemory: string | null | undefined

function aspectParam(model: CatalogModel | null | undefined) {
  return model?.params.find((param) => ASPECT_PARAM_NAMES.has(param.name))
}

function readPromptAspectSession(): string | null {
  if (promptAspectMemory !== undefined) return promptAspectMemory
  try {
    promptAspectMemory = sessionStorage.getItem(PROMPT_ASPECT_SESSION_KEY)
  } catch {
    promptAspectMemory = null
  }
  return promptAspectMemory
}

/**
 * Десктопный промпт начинает с «Авто», но ручной выбор становится общим для
 * остальных досок и моделей до закрытия вкладки. Значение из localStorage или
 * старого черновика намеренно не побеждает эту память: новая сессия снова
 * обязана начинаться с «Авто».
 */
export function applyPromptAspectSession(
  model: CatalogModel | null | undefined,
  current: Record<string, unknown>,
  allowVirtualAuto = false,
): Record<string, unknown> {
  const spec = aspectParam(model)
  const options = spec?.options?.map((option) => option.value) ?? []
  if (supportsVirtualAspectAuto(spec, allowVirtualAuto)) options.unshift('auto')
  if (!spec || !options.includes('auto')) return current
  const remembered = readPromptAspectSession()
  const value = remembered && options.includes(remembered) ? remembered : 'auto'
  if (current[spec.name] === value) return current
  return { ...current, [spec.name]: value }
}

export function rememberPromptAspectSession(
  model: CatalogModel | null | undefined,
  params: Record<string, unknown>,
  allowVirtualAuto = false,
): void {
  const spec = aspectParam(model)
  const value = spec ? params[spec.name] : undefined
  if (typeof value !== 'string' || !(spec?.options?.some((option) => option.value === value)
    || (value === 'auto' && supportsVirtualAspectAuto(spec, allowVirtualAuto)))) return
  promptAspectMemory = value
  try {
    sessionStorage.setItem(PROMPT_ASPECT_SESSION_KEY, value)
  } catch {
    // sessionStorage может быть запрещён политикой браузера; память модуля
    // всё равно сохраняет выбор до перезагрузки.
  }
}

export function withoutPromptAspectPersistence(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const persistent = { ...params }
  for (const name of ASPECT_PARAM_NAMES) delete persistent[name]
  return persistent
}

export function resetPromptAspectSessionForTests(): void {
  promptAspectMemory = undefined
  try {
    sessionStorage.removeItem(PROMPT_ASPECT_SESSION_KEY)
  } catch {
    // В Node-тестах sessionStorage отсутствует.
  }
}

// Дефолтная модель типа для канваса: картинки — ChatGPT Image 2 (по просьбе),
// видео — первая в списке базовых. «Авто» на канвасе нет.
export function defaultModelId(
  models: CatalogModel[],
  kind: string,
  defaults?: CatalogDefaults,
): string | null {
  const bases = baseModels(models, kind as never).filter(model => !executorCompatibilityError(model))
  const slot = kind === 'text'
    ? 'assistant'
    : kind === 'image' || kind === 'video' || kind === 'audio'
      ? kind
      : null
  const preferred = slot ? defaults?.[slot] : null
  if (preferred && bases.some(model => model.id === preferred)) return preferred
  if (kind === 'image') {
    const gpt = bases.find((model) => model.id === 'chatgpt-image-2')
    if (gpt) return gpt.id
  }
  return bases[0]?.id ?? null
}

// Пропорции при появлении и снятии референса. Правило одно, но применялось из
// ДВУХ эффектов с почти одинаковым, руками продублированным кодом — и именно
// такое расхождение однажды превращало портретный референс в квадрат.
//
// Есть медиа-референс → «Авто» (результат подстроится под референс).
// Референса нет → «Авто» не к чему привязать, берём конкретную пропорцию.
export function aspectForRefs(
  model: CatalogModel | null | undefined,
  current: Record<string, unknown>,
  hasMediaRefs: boolean,
): Record<string, unknown> {
  // ⚠️ Имя параметра задаёт каталог: у своего это `aspect_ratio`, у сервера
  // команды — `aspect`. Правило искало только первое и на сетевой доске не
  // делало ничего: нода и планшет оставались на 4:3 при любом референсе.
  const spec = aspectParam(model)
  const name = spec?.name ?? 'aspect_ratio'
  const supportsAuto = spec?.options?.some((option) => option.value === 'auto') ?? false

  if (hasMediaRefs) {
    if (!supportsAuto || current[name] === 'auto') return current
    return { ...current, [name]: 'auto' }
  }

  if (current[name] !== 'auto') return current
  // Канон сервера команды: такой «Авто» значит «параметр не задан» — сервер не
  // шлёт его провайдеру. Подменить его первым пунктом (1:1, у Gemini Omni —
  // 9:16) значило бы молча поменять результат.
  if (autoMeansUnset(spec)) return current
  const firstConcrete = spec?.options?.find((option) => option.value !== 'auto')?.value
  const fallback = spec?.default !== 'auto' ? spec?.default : (firstConcrete ?? '1:1')
  return { ...current, [name]: fallback }
}
