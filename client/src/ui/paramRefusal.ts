/**
 * Отказ сервера команды «не то значение параметра» — английской фразой.
 *
 * Сервер команды пишет отказ по-русски («Модель «Grok Image» не умеет «Размер:
 * 4K» — выберите…»): его читают журнал и прежние приложения. Интерфейс же
 * английский, и `systemMessage` без перевода показывал «Request failed. Open
 * the diagnostic log» — человек не узнавал, что выбрал ступень, которой у
 * модели нет (20.10.2026).
 *
 * Путей два. **Код и подробности** (`MODEL_PARAM_UNSUPPORTED`,
 * `MODEL_PARAM_AUTO_NEEDS_REFS`): сервер присылает id параметра и значения и
 * подписи формы — те же английские слова, что в настройках, — и фраза
 * собирается из них. **Шаблон русской фразы** — там, где кода нет: прежний
 * сервер команды, ошибка задачи (`job.error` — строка) и шаг макроса. Фразу
 * сервер закрепляет тестом (paramLabels.test.ts в canai-cloud); меняют её
 * там — поправь шаблон здесь.
 */

export const PARAM_REFUSAL_CODES = {
  unsupported: 'MODEL_PARAM_UNSUPPORTED',
  autoNeedsRefs: 'MODEL_PARAM_AUTO_NEEDS_REFS',
} as const

const CYRILLIC = /[А-Яа-яЁё]/u

function unsupportedText(model: string, param: string, value: string): string {
  return `“${model}” does not support “${param}: ${value}”. Choose another value in the settings.`
}

function autoNeedsRefsText(model: string, param: string): string {
  return `“Auto” in “${param}” works with “${model}” only when a reference is attached. Attach an image or choose a specific ${param.toLowerCase()}.`
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Фраза по коду и подробностям; null — код не наш или подробности негодные. */
export function paramRefusalMessage(code: string | undefined, details: unknown): string | null {
  if (code !== PARAM_REFUSAL_CODES.unsupported && code !== PARAM_REFUSAL_CODES.autoNeedsRefs) return null
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const record = details as Record<string, unknown>
  const model = text(record.model)
  const param = text(record.paramLabel) ?? text(record.param)
  if (!model || !param) return null
  if (code === PARAM_REFUSAL_CODES.autoNeedsRefs) return autoNeedsRefsText(model, param)
  const value = text(record.valueLabel) ?? text(record.value)
  return value ? unsupportedText(model, param, value) : null
}

// Слова, которыми прежний сервер команды называл параметры и значения в
// отказе (RU_NAMES, RU_VALUES и подписи формы в его paramSpecs.ts), — и их
// английские подписи, как в форме своей доски.
const RU_PARAMS: Readonly<Record<string, string>> = {
  'качество': 'Quality',
  'фон': 'Background',
  'качество jpeg/webp': 'JPEG/WebP quality',
  'пропорции': 'Aspect ratio',
  'размер': 'Resolution',
  'длительность, с': 'Duration (sec)',
  'зерно': 'Seed',
  'формат': 'File format',
  'чего избегать': 'Negative prompt',
}

const RU_VALUES: Readonly<Record<string, string>> = {
  'авто': 'Auto',
  'низкое': 'Low',
  'среднее': 'Medium',
  'высокое': 'High',
  'очень высокое': 'Very high',
  'максимальное': 'Maximum',
  'непрозрачный': 'Opaque',
  'прозрачный': 'Transparent',
}

const RATIO = /\d+(?:\.\d+)?:\d+(?:\.\d+)?/u

/** Русское слово — английским; незнакомое русское — null (не выдумываем). */
function fromRussian(value: string, table: Readonly<Record<string, string>>): string | null {
  const word = value.trim()
  if (!CYRILLIC.test(word)) return word
  const key = word.toLowerCase()
  if (Object.hasOwn(table, key)) return table[key]
  // Прежние подписи пропорций: «Широкий 16:9», «Квадрат 1:1».
  return word.match(RATIO)?.[0] ?? null
}

const UNSUPPORTED = /Модель «([^«»\n]+)» не умеет «([^«»\n:]+): ([^«»\n]+)»/u
const AUTO_NEEDS_REFS = /«Авто» в «([^«»\n]+)» у модели «([^«»\n]+)» работает только с референсом/u

/** Фраза по русскому тексту отказа; null — это не отказ параметра. */
export function legacyParamRefusal(message: string): string | null {
  const unsupported = message.match(UNSUPPORTED)
  if (unsupported) {
    const param = fromRussian(unsupported[2], RU_PARAMS)
    const value = fromRussian(unsupported[3], RU_VALUES)
    return param && value ? withPrefix(message, unsupported.index, unsupportedText(unsupported[1], param, value)) : null
  }
  const auto = message.match(AUTO_NEEDS_REFS)
  if (auto) {
    const param = fromRussian(auto[1], RU_PARAMS)
    return param ? withPrefix(message, auto.index, autoNeedsRefsText(auto[2], param)) : null
  }
  return null
}

/** Английское начало («Generation failed: …») сохраняем, русское — нет. */
function withPrefix(message: string, index: number | undefined, english: string): string {
  const prefix = message.slice(0, index ?? 0)
  return prefix && !CYRILLIC.test(prefix) ? `${prefix}${english}` : english
}
