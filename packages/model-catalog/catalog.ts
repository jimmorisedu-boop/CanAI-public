// Каталог моделей fal + определение типа по endpoint'у.
//
// Идея перенесена из Spagetti (модель = fal-endpoint), но компактно: здесь
// только проверенные endpoint'ы как пресеты; любую другую модель fal можно
// задать «своим endpoint'ом» — тип и дефолты подберутся автоматически.

export type ModelKind = 'image' | 'video' | 'text' | 'audio' | 'other'
import { CATALOG_REVISION, ADAPTER_VERSION } from './version.js'
import { variantForImageCount } from './imageCapacity.js'
import { GPT_IMAGE_2_QUALITY, GPT_IMAGE_25_QUALITY, GPT_IMAGE_INPUT_IMAGE_USD, gptImagePriceTable } from './gptImagePricing.js'
export { CATALOG_REVISION, ADAPTER_VERSION } from './version.js'
export { variantForImageCount } from './imageCapacity.js'
export type InputModality = 'text' | 'image' | 'video' | 'audio'

// Описание настраиваемого параметра модели (готовое поле формы — как
// FormFieldConfig в WaveSpeed, но без слоя конвертации из JSON-Schema).
export type ParamWidget = 'number' | 'slider' | 'select' | 'boolean' | 'textarea' | 'seed'

export interface ParamSpec {
  activeWhen?: { name: string; values: string[] }
  name: string
  label: string
  widget: ParamWidget
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: Array<{ value: string; label: string }>
}

export interface TextTokenPricing {
  inputPerMillion: number
  outputPerMillion: number
  cachedInputPerMillion?: number
  checkedAt: string
}

export interface MediaPricing {
  /** `call` is a provider per-request estimate; it is never treated as an image or second. */
  unit: 'image' | 'second' | 'call'
  usd: number
  defaultDuration?: number
  // Каким параметром задаётся длительность у посекундной модели; по умолчанию
  // `duration`. У звуковых эффектов ElevenLabs он зовётся `duration_seconds`, и
  // без этого поля цена считалась бы по запасной длительности, а не по слайдеру.
  durationParam?: string
  // ⚠️ fal берёт `usd` за каждые столько знаков текста (озвучка ElevenLabs —
  // $0.05 за 1000). Неполная тысяча считается целой: занизить хуже. Длину
  // текста не узнать заранее — цены нет вовсе, а не «как за короткую фразу».
  perPromptChars?: number
  // ⚠️ fal берёт столько за мегапиксель РЕЗУЛЬТАТА (апскейл SeedVR). Размер
  // результата считается по входной картинке и ручкам upscale_mode /
  // upscale_factor / target_resolution; входа не знаем — цены нет.
  perOutputMegapixel?: number
  // Фиксированная доплата за каждый входной референс (не зависит от длительности).
  perReferenceUsd?: number
  // Некоторые edit-endpoint'ы включают в базовую цену только первый референс.
  additionalReferenceUsd?: number
  byParam?: {
    name: string
    usd: Record<string, number>
  }
  byParams?: {
    names: string[]
    usd: Record<string, number>
  }
}

export interface CatalogModel {
  imageInputField?: 'image_url' | 'image_urls'
  /** Conditional input contracts discovered from the provider schema. */
  conditionalReferenceRequirement?: 'image-or-video-or-pdf'
  contractRevision?: string
  adapterVersion?: number
  minExecutorVersion?: number
  lifecycle?: 'active' | 'archived' | 'disabled'
  pricingNote?: string
  id: string
  name: string
  kind: ModelKind
  endpoint: string
  // принимает картинки-референсы (edit / image-to-video)
  refs?: boolean
  // у базовой (text→X) модели — id её ref-варианта (edit / image-to-video);
  // при наличии референса resolveModel сам переключит на него
  pairId?: string
  // умеет принимать ВИДЕО-референс (video-to-video редактирование), а не
  // только картинку/текст
  videoRefs?: boolean
  // у базовой видео-модели — id её видео-ref-варианта; при выделении видео
  // на канвасе resolveModel переключит именно на него (приоритет выше pairId)
  videoPairId?: string
  // КАКИМ полем слать видео этой модели — задаём ЯВНО, не угадываем по строке
  // endpoint'а: у Seedance и Gemini обе модели называются «reference-to-video»,
  // но Seedance берёт видео (video_urls), а Gemini — только картинки
  videoInputField?: 'video_url' | 'video_urls'
  // Явное поле аудиореференсов; сейчас оно есть у Seedance reference-to-video.
  audioInputField?: 'audio_url' | 'audio_urls'
  // ⚠️ Модель умеет ПОСЛЕДНИЙ кадр отдельным полем (первый идёт в image_url,
  // второй — сюда). Задаётся ЯВНО: раньше это была прибитая проверка строки
  // endpoint'а Seedance в fal.ts, и вторая такая модель молча теряла бы
  // последний кадр.
  endImageInputField?: 'end_image_url'
  // Отдельные utility-модели могут называть текстовый запрос иначе, чем prompt.
  // 'text' — у моделей ElevenLabs (сверено по openapi): промпт там называется
  // text, и без этого поля запрос уходил бы в пустоту.
  promptInputField?: 'prompt' | 'text_prompt' | 'text' | null
  // У utility-модели может быть дополнительный числовой выход seed.
  seedOutput?: boolean
  // умеет ли модель ссылаться на КОНКРЕТНЫЙ референс внутри текста промпта и в
  // каком синтаксисе (сверено по openapi 2026-07-14): 'gemini' → <IMAGE_REF_0>
  // (0-based, только картинки), 'seedance' → @Image1/@Video1 (1-based, по
  // модальностям). Клиент вставляет нейтральное @1/@2, сервер переводит в этот
  // формат (модели без стиля — токены убираются, см. applyRefTags).
  refTagStyle?: 'gemini' | 'seedance'
  // жёсткие параметры по умолчанию (не показываются в форме)
  defaults?: Record<string, unknown>
  // настраиваемые параметры (форма на ноде)
  params?: ParamSpec[]
  // скрыть из дропдауна канваса (курированный список), но оставить доступной
  // в нодах — там ModelPicker показывает более широкий список пресетов
  canvasHidden?: boolean
  // ⚠️ Модель принимает промпт ТОЛЬКО по-английски. Lyria на русский текст
  // отвечает «Unsupported language detected. Please use English» — уже после
  // запуска, то есть человек узнаёт об этом, потратив время (найдено прогоном
  // 20.08.2026). Интерфейс у нас русский, поэтому про такие модели надо
  // предупреждать ДО кнопки.
  englishPromptOnly?: boolean
  pricing?: MediaPricing
  textPricing?: TextTokenPricing
  contextWindowTokens?: number
  inputModalities?: InputModality[]
  mediaInputMode?: 'single' | 'mixed'
  maxImageRefs?: number
  minImageRefs?: number
  maxVideoRefs?: number
  minVideoRefs?: number
  maxAudioRefs?: number
  /** Сколько аудио нужно ОБЯЗАТЕЛЬНО: у разделения дорожки без звука нет входа. */
  minAudioRefs?: number
  maxTotalRefs?: number
  audioRequiresVisualRef?: boolean
  audioFormats?: string[]
}

/** Parameter names that carry a document/PDF URL context input. */
export function isPdfInputParamName(name: string): boolean {
  // The Nano Banana edit contract sends exactly `pdf_url`. Keep this narrow:
  // arbitrary `document_url`/`custom__pdf_url` params are passed through as
  // unknown provider fields and must not satisfy the conditional input gate.
  return name === 'pdf_url'
}

// Повторно используемые описания полей. Параметры и их допустимые значения
// сверены с реальными схемами моделей на fal.ai (см. заметку у CATALOG) —
// у разных семей моделей набор ручек РАЗНЫЙ, поэтому специй несколько.
const opts = (values: string[]) => values.map((v) => ({ value: v, label: v }))
const aspectOpts = (values: string[]) =>
  values.map((value) => ({ value, label: value === 'auto' ? 'Auto' : value }))

// ── картинки ──
const COMMON_IMAGE_ASPECTS = aspectOpts([
  'auto',
  '1:1',
  '3:4',
  '9:16',
  '4:3',
  '16:9',
])

// Nano Banana 2 (Gemini 3.1 Flash Image): свои пропорции и разрешение
const NANO_2_ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: '1:1',
  options: aspectOpts(['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8']),
}
const NANO_2_EDIT_ASPECT: ParamSpec = {
  ...NANO_2_ASPECT,
  default: 'auto',
}
const NANO_2_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '1K',
  options: opts(['0.5K', '1K', '2K', '4K']),
}
const NANO_PRO_ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: '1:1',
  options: aspectOpts(['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16']),
}
const NANO_PRO_EDIT_ASPECT: ParamSpec = {
  ...NANO_PRO_ASPECT,
  default: 'auto',
}
const NANO_PRO_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '1K',
  options: opts(['1K', '2K', '4K']),
}
// GPT Image 2 и Seedream показывают тот же пользовательский контракт, что
// Nano Banana. В их нативный image_size значения переводит imageParams.ts.
const SEEDREAM_ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: 'auto',
  options: COMMON_IMAGE_ASPECTS,
}
const SEEDREAM_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '2K',
  options: opts(['1K', '2K']),
}
const GPT_ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: '4:3',
  options: COMMON_IMAGE_ASPECTS,
}
const GPT_EDIT_ASPECT: ParamSpec = {
  ...GPT_ASPECT,
  default: 'auto',
}
const GPT_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '1K',
  options: opts(['1K', '2K', '4K']),
}
const GPT_QUALITY: ParamSpec = {
  name: 'quality',
  label: 'Quality',
  widget: 'select',
  default: 'high',
  options: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
}
const NUM_IMAGES: ParamSpec = { name: 'num_images', label: 'Number of images', widget: 'slider', default: 1, min: 1, max: 4, step: 1 }
const SEED: ParamSpec = { name: 'seed', label: 'Seed', widget: 'seed', default: -1 }

// ── звук (схемы сверены по openapi fal 18.08.2026) ──
const NEGATIVE_PROMPT: ParamSpec = { name: 'negative_prompt', label: 'Negative prompt', widget: 'textarea', default: 'low quality' }
const TTS_VOICE: ParamSpec = { name: 'voice', label: 'Voice', widget: 'textarea', default: 'Rachel' }
const TTS_STABILITY: ParamSpec = { name: 'stability', label: 'Speech stability', widget: 'slider', default: 0.5, min: 0, max: 1, step: 0.05 }
const TTS_SPEED: ParamSpec = { name: 'speed', label: 'Speed', widget: 'slider', default: 1, min: 0.7, max: 1.2, step: 0.05 }
const SFX_DURATION: ParamSpec = { name: 'duration_seconds', label: 'Duration (sec)', widget: 'slider', default: 4, min: 1, max: 22, step: 1 }
const SFX_INFLUENCE: ParamSpec = { name: 'prompt_influence', label: 'Prompt adherence', widget: 'slider', default: 0.3, min: 0, max: 1, step: 0.05 }
// Разделение дорожки (SAM Audio). Значения сверены по openapi 19.08.2026.
const SEPARATE_FORMAT: ParamSpec = {
  name: 'output_format',
  label: 'File format',
  widget: 'select',
  default: 'mp3',
  options: opts(['mp3', 'wav']),
}
const SEPARATE_ACCELERATION: ParamSpec = {
  name: 'acceleration',
  label: 'Speed vs. quality',
  widget: 'select',
  default: 'balanced',
  options: [
    { value: 'fast', label: 'Fast' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'quality', label: 'Quality' },
  ],
}
const SEPARATE_CANDIDATES: ParamSpec = { name: 'reranking_candidates', label: 'Ranking candidates', widget: 'slider', default: 1, min: 1, max: 7, step: 1 }
const OUTPUT_FORMAT: ParamSpec = {
  name: 'output_format',
  label: 'File format',
  widget: 'select',
  default: 'png',
  options: [
    { value: 'png', label: 'PNG' },
    { value: 'jpeg', label: 'JPEG' },
    { value: 'webp', label: 'WebP' },
  ],
}
const SAFETY: ParamSpec = { name: 'enable_safety_checker', label: 'Safety filter', widget: 'boolean', default: true }

// ── SeedVR2 Seamless Upscale ──
const UPSCALE_MODE: ParamSpec = {
  name: 'upscale_mode',
  label: 'Upscale mode',
  widget: 'select',
  default: 'factor',
  options: [
    { value: 'factor', label: 'By scale factor' },
    { value: 'target', label: 'To target resolution' },
  ],
}
const UPSCALE_FACTOR: ParamSpec = {
  name: 'upscale_factor',
  label: 'Scale',
  widget: 'slider',
  default: 2,
  min: 1,
  max: 10,
  step: 0.1,
}
const TARGET_RESOLUTION: ParamSpec = {
  name: 'target_resolution',
  label: 'Target resolution',
  widget: 'select',
  default: '1080p',
  // В интерфейсе используем привычные уровни 1K/2K/4K, но в fal отправляем
  // точные значения из контракта SeedVR.
  options: [
    { value: '720p', label: '1K' },
    { value: '1080p', label: '2K' },
    { value: '2160p', label: '4K' },
  ],
}
const NOISE_SCALE: ParamSpec = {
  name: 'noise_scale',
  label: 'Denoise strength',
  widget: 'slider',
  default: 0.1,
  min: 0,
  max: 1,
  step: 0.001,
}
// Grok Imagine Image (картинки xAI): много соотношений, разрешение 1k/2k, без seed
const GROK_IMG_ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: '1:1',
  options: aspectOpts(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '20:9', '19.5:9', '9:19.5', '9:20']),
}
// edit — то же, но по умолчанию auto (размер подстраивается под референс)
const GROK_IMG_ASPECT_EDIT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: 'auto',
  options: aspectOpts(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '20:9', '19.5:9', '9:19.5', '9:20']),
}
const GROK_IMG_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '1k',
  options: opts(['1k', '2k']),
}

// ── ideogram/character/edit ──
const RENDERING_SPEED: ParamSpec = {
  name: 'rendering_speed',
  label: 'Rendering speed',
  widget: 'select',
  default: 'BALANCED',
  options: [
    { value: 'TURBO', label: 'Fast (Turbo)' },
    { value: 'BALANCED', label: 'Balanced' },
    { value: 'QUALITY', label: 'Quality' },
  ],
}

const EXPAND_PROMPT: ParamSpec = {
  name: 'expand_prompt',
  label: 'MagicPrompt (auto expand)',
  widget: 'boolean',
  default: true,
}

// ── sam-3/image ──
const APPLY_MASK: ParamSpec = {
  name: 'apply_mask',
  label: 'Apply mask to image',
  widget: 'boolean',
  default: true,
}

const RETURN_MULTIPLE_MASKS: ParamSpec = {
  name: 'return_multiple_masks',
  label: 'Return multiple masks',
  widget: 'boolean',
  default: false,
}

const MAX_MASKS: ParamSpec = {
  name: 'max_masks',
  label: 'Maximum masks',
  widget: 'slider',
  default: 3,
  min: 1,
  max: 32,
  step: 1,
}

const INCLUDE_SCORES: ParamSpec = {
  name: 'include_scores',
  label: 'Show confidence scores',
  widget: 'boolean',
  default: false,
}

const INCLUDE_BOXES: ParamSpec = {
  name: 'include_boxes',
  label: 'Show object boxes (bounding boxes)',
  widget: 'boolean',
  default: false,
}

// ── видео ──
const SEEDANCE_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '720p',
  options: opts(['480p', '720p', '1080p', '4k']),
}
const GROK_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '720p',
  options: opts(['auto', '480p', '720p']),
}
const GROK_15_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '720p',
  options: opts(['480p', '720p', '1080p']),
}
// Grok — edit video (video-to-video): auto = как у входного видео
const GROK_EDIT_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: 'auto',
  options: opts(['auto', '480p', '720p']),
}
// Grok: длительность числом (1–15 сек, дефолт 6)
const VIDEO_DURATION: ParamSpec = { name: 'duration', label: 'Duration (sec)', widget: 'slider', default: 6, min: 1, max: 15, step: 1 }

// ── MiniMax H3 Max (схема сверена по openapi fal 27.08.2026) ──
// ⚠️ Разрешение пишется ЗАГЛАВНЫМИ («480P»/«768P») — именно так в enum'е fal.
// Строчные там не приняли бы, а расчёт цены ищет ключ по этому же значению.
const H3_RESOLUTION: ParamSpec = {
  name: 'resolution',
  label: 'Resolution',
  widget: 'select',
  default: '768P',
  options: opts(['480P', '768P']),
}
const H3_DURATION: ParamSpec = { name: 'duration', label: 'Duration (sec)', widget: 'slider', default: 5, min: 5, max: 15, step: 1 }
const H3_ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: '16:9',
  options: opts(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
}
// ⚠️ Поле ОБЯЗАТЕЛЬНОЕ по схеме: без него запрос не примут. Дефолт из ParamSpec
// подставляется всегда (paramDefaults в resolveModel), поэтому отдельной записи
// в defaults не нужно — но убирать параметр из списка нельзя.
const H3_EXPANSION: ParamSpec = {
  name: 'prompt_expansion_mode',
  label: 'Expand prompt',
  widget: 'select',
  default: 'balanced',
  options: [
    { value: 'disabled', label: 'Off' },
    { value: 'balanced', label: 'Medium' },
    { value: 'quality', label: 'Max' },
  ],
}
// Seedance 2.0: fal принимает строковый enum 4..15 или auto.
const SEEDANCE_DURATION: ParamSpec = {
  name: 'duration',
  label: 'Duration (sec)',
  widget: 'select',
  default: 'auto',
  options: opts(['auto', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15']),
}
const SEEDANCE_BITRATE: ParamSpec = {
  name: 'bitrate_mode',
  label: 'Bitrate',
  widget: 'select',
  default: 'standard',
  options: [
    { value: 'standard', label: 'Standard' },
    { value: 'high', label: 'High' },
  ],
}
// Gemini Omni Flash: длительность числом (3–10 сек), аудио генерится нативно
const GEMINI_DURATION: ParamSpec = { name: 'duration', label: 'Duration (sec)', widget: 'slider', default: 8, min: 3, max: 10, step: 1 }
// Seedance: соотношение сторон (auto + набор)
const ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: 'auto',
  options: opts(['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
}
// Grok: без auto/21:9, зато 3:2 и 2:3
const GROK_ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: '16:9',
  options: opts(['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16']),
}
const GROK_I2V_ASPECT: ParamSpec = {
  ...GROK_ASPECT,
  default: 'auto',
  options: opts(['auto', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16']),
}
// Gemini Omni Flash: только 16:9 / 9:16
const VEO_ASPECT: ParamSpec = {
  name: 'aspect_ratio',
  label: 'Aspect ratio',
  widget: 'select',
  default: '16:9',
  options: opts(['16:9', '9:16']),
}
const GENERATE_AUDIO: ParamSpec = { name: 'generate_audio', label: 'With audio', widget: 'boolean', default: true }

// ── текст (LLM) ──
const SYSTEM_PROMPT: ParamSpec = { name: 'system_prompt', label: 'System prompt', widget: 'textarea', default: '' }
const TEMPERATURE: ParamSpec = { name: 'temperature', label: 'Temperature (creativity)', widget: 'slider', default: 1, min: 0, max: 2, step: 0.1 }
// Минимум 128, а не 64: у моделей с размышлением (у Gemini reasoning включён в
// defaults) рассуждение тратит тот же бюджет, и при 64 ответ приходит ПУСТОЙ —
// проверено живым запуском 2026-08-07. Пользователь при этом видел лишь «LLM
// вернул пустой ответ», а 64 было ровно тем значением, которое разрешал UI.
const MAX_TOKENS: ParamSpec = { name: 'max_tokens', label: 'Response token limit', widget: 'number', default: 1024, min: 128, max: 8192, step: 64 }
const LLM_PARAMS = [SYSTEM_PROMPT, TEMPERATURE, MAX_TOKENS]
const LLM_PARAMS_NO_TEMPERATURE = [SYSTEM_PROMPT, MAX_TOKENS]
const TEXT_PRICING = {
  gemini: { inputPerMillion: 1.5, outputPerMillion: 7.5, cachedInputPerMillion: 0.15, checkedAt: '2026-10-06' },
  chatgpt: { inputPerMillion: 1.25, outputPerMillion: 7.5, cachedInputPerMillion: 0.125, checkedAt: '2026-10-06' },
  claude: { inputPerMillion: 4, outputPerMillion: 20, cachedInputPerMillion: 0.2, checkedAt: '2026-10-06' },
  grok: { inputPerMillion: 2, outputPerMillion: 6, cachedInputPerMillion: 0.5, checkedAt: '2026-10-06' },
  qwen: { inputPerMillion: 0.03, outputPerMillion: 0.13, cachedInputPerMillion: 0.006, checkedAt: '2026-10-06' },
  deepseek: { inputPerMillion: 0.02, outputPerMillion: 1.2, cachedInputPerMillion: 0.006, checkedAt: '2026-10-06' },
} as const

// ── GPT Image 2: цена по кадру, который уходит в fal (gptImagePricing.ts) ──
// ⚠️ Не строками таблицы fal: 2K и 4K у нас — свой размер по пропорциям
// (квадрат 2K стоит $0.43, а строка «2K» в таблице — $0.222), пресет 16:9 —
// 1088×608, 3:4 — 768×1024. Создание и правка — разные таблицы: у правки в
// клетке одна входная картинка, каждая следующая — additionalReferenceUsd.
// «auto» у разрешения — прежнее значение старых досок, переводчик читает его
// как 1K.
const GPT_ASPECT_VALUES = COMMON_IMAGE_ASPECTS.map((option) => option.value)
const GPT_RESOLUTION_VALUES = ['auto', '1K', '2K', '4K']
const GPT_IMAGE_2_PRICES = gptImagePriceTable({
  aspects: GPT_ASPECT_VALUES, resolutions: GPT_RESOLUTION_VALUES, qualities: GPT_IMAGE_2_QUALITY, withInputImage: false,
})
const GPT_IMAGE_2_EDIT_PRICES = gptImagePriceTable({
  aspects: GPT_ASPECT_VALUES, resolutions: GPT_RESOLUTION_VALUES, qualities: GPT_IMAGE_2_QUALITY, withInputImage: true,
})
/** Лестница качества при умолчаниях формы — запасной путь, если таблица промахнулась. */
function gptQualityLadder(table: Record<string, number>, aspect: string): { name: string; usd: Record<string, number> } {
  const usd: Record<string, number> = {}
  for (const quality of Object.keys(GPT_IMAGE_2_QUALITY)) usd[quality] = table[`${aspect}|1K|${quality}`]!
  return { name: 'quality', usd }
}

// Курируемый список моделей: LLM — Gemini/GPT/Claude/Qwen; картинки —
// Nano Banana / Seedream 5 Pro / ChatGPT Image 2; видео — Seedance 2 / Grok /
// Gemini Omni Flash. Порядок = порядок в списке.
//
// ENDPOINT'Ы СВЕРЕНЫ по fal.ai/models 2026-07-12 (первый реальный прогон дал
// «Path /edit-image not found» — все пути, кроме nano-banana, были догадками с
// неверными префиксами/версиями). Точные: GPT Image 2 → openai/gpt-image-2(/edit);
// Seedream 5 Pro → bytedance/seedream/v5/pro/... (без fal-ai/); Seedance 2 →
// bytedance/seedance-2.0/... (не /v2/pro/); Grok → xai/grok-imagine-video/...;
// «Veo Omni» — ярлык пользователя для Google Gemini Omni Flash:
// google/gemini-omni-flash (text→video) + /reference-to-video (по картинкам,
// массив image_urls — см. inferImageInput). Настоящий Veo (fal-ai/veo3.1) —
// другая модель, здесь НЕ она.
// Медиа-модели сверены по openapi-схемам fal 2026-07-29. LLM обновлены
// 2026-07-28: deprecated fal-ai/any-llm заменён на openrouter/router, конкретные
// model id сверены по каталогу OpenRouter. Схему любого fal endpoint читать так:
// https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>
const GPT_25_PARAMS: ParamSpec[] = [
  GPT_ASPECT, GPT_RESOLUTION,
  { name: 'quality', label: 'Quality', widget: 'select', default: 'high', options: [
    { value: 'auto', label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Very high' },
    { value: 'max', label: 'Maximum' },
  ] },
  { name: 'background', label: 'Background', widget: 'select', default: 'auto', options: [{ value: 'auto', label: 'Auto' }, { value: 'opaque', label: 'Opaque' }, { value: 'transparent', label: 'Transparent' }] },
  OUTPUT_FORMAT,
  { name: 'output_compression', label: 'JPEG/WebP quality', widget: 'slider', min: 0, max: 100, step: 1, activeWhen: { name: 'output_format', values: ['jpeg', 'webp'] } },
  NUM_IMAGES,
]

// ── GPT Image 2.5 (Flare/Sunburst): оценка цены по кадру (gptImagePricing.ts) ──
// fal считает эти модели по токенам, а списывается фактический расход. Таблица
// fal на странице модели — та же формула токенов, но для её шести кадров, а не
// для наших (2K у нас — 2048 по длинной стороне, пресет 16:9 — 1088×608).
// Поэтому оценку считаем той же формулой, что у GPT Image 2, от кадра
// переводчика; множители качества у 2.5 свои: 16/24/48/64/96 (сверено со всеми
// 30 клетками таблицы fal и со списаниями сервера команды 20.10.2026).
// ⚠️ Входная картинка правки в таблицу fal НЕ входит: по журналу каждая
// добавляет ~$0.012. Раньше оценка правки её не учитывала — теперь у правки
// своя таблица с одной картинкой, следующие — additionalReferenceUsd.
// ⚠️ Это ОЦЕНКА: длинный промпт и сложный запрос дороже. Раньше вместо неё
// показывали резерв $2 — в 4–40 раз больше настоящей цены (жалоба 21.09.2026).
const GPT_25_TABLE_OPTIONS = {
  aspects: GPT_ASPECT_VALUES, resolutions: GPT_RESOLUTION_VALUES, qualities: GPT_IMAGE_25_QUALITY,
}
/** Создание без референса. */
export const GPT_25_PRICES = gptImagePriceTable({ ...GPT_25_TABLE_OPTIONS, withInputImage: false })
/** Правка по референсам: в клетке одна входная картинка. */
export const GPT_25_EDIT_PRICES = gptImagePriceTable({ ...GPT_25_TABLE_OPTIONS, withInputImage: true })
/** Каждая входная картинка сверх первой. */
export const GPT_25_EXTRA_REFERENCE_USD = GPT_IMAGE_INPUT_IMAGE_USD

const GPT_25_MODELS: CatalogModel[] = ['flare', 'sunburst'].flatMap((variant) => {
  const id = `gpt-image-2.5-${variant}`
  const name = `GPT Image 2.5 ${variant === 'flare' ? 'Flare' : 'Sunburst'}`
  return [false, true].map((edit): CatalogModel => ({
    id: edit ? `${id}-edit` : id, name: edit ? `${name} — by reference` : name,
    kind: 'image', endpoint: `openai/gpt-image-2.5/${variant}/${edit ? 'edit' : 'text-to-image'}`,
    minExecutorVersion: 2,
    ...(edit ? { refs: true, minImageRefs: 1, maxImageRefs: 16, maxTotalRefs: 16 } : { pairId: `${id}-edit` }),
    defaults: { output_format: 'png' },
    params: GPT_25_PARAMS.map(p => edit && p.name === 'aspect_ratio' ? GPT_EDIT_ASPECT : p),
    pricing: {
      unit: 'image',
      usd: (edit ? GPT_25_EDIT_PRICES['auto|1K|high'] : GPT_25_PRICES['4:3|1K|high'])!,
      byParams: { names: ['aspect_ratio', 'resolution', 'quality'], usd: edit ? GPT_25_EDIT_PRICES : GPT_25_PRICES },
      ...(edit ? { additionalReferenceUsd: GPT_25_EXTRA_REFERENCE_USD } : {}),
    },
    pricingNote: 'Estimated price for the output size at fal token rates: the actual usage is charged; longer prompts and complex requests cost more.',
  }))
})

export const CATALOG: CatalogModel[] = [
  // ── текст (LLM) через fal OpenRouter; конкретная модель в defaults.model ──
  // Фиксированная UX-оценка = примерно 1000 входных + 1000 выходных токенов
  // по тарифам на 2026-10-06; фактическая стоимость у fal зависит от usage.
  { id: 'gemini', name: 'Gemini 3.8 Flash', kind: 'text', endpoint: 'openrouter/router', inputModalities: ['text', 'image', 'video', 'audio'], mediaInputMode: 'single', maxImageRefs: 16, maxVideoRefs: 16, maxAudioRefs: 1, maxTotalRefs: 16, defaults: { model: 'google/gemini-3.8-flash', reasoning: true }, params: LLM_PARAMS, pricing: { unit: 'image', usd: 0.009 }, textPricing: TEXT_PRICING.gemini, contextWindowTokens: 1_000_000 },
  { id: 'chatgpt', name: 'GPT-6 Sol', kind: 'text', endpoint: 'openrouter/router', inputModalities: ['text', 'image'], mediaInputMode: 'single', maxImageRefs: 16, maxTotalRefs: 16, defaults: { model: 'openai/gpt-6-sol' }, params: LLM_PARAMS_NO_TEMPERATURE, pricing: { unit: 'image', usd: 0.00875 }, textPricing: TEXT_PRICING.chatgpt, contextWindowTokens: 400_000 },
  { id: 'claude', name: 'Claude Opus 5.5', kind: 'text', endpoint: 'openrouter/router', inputModalities: ['text', 'image'], mediaInputMode: 'single', maxImageRefs: 16, maxTotalRefs: 16, defaults: { model: 'anthropic/claude-opus-5.5' }, params: LLM_PARAMS, pricing: { unit: 'image', usd: 0.024 }, textPricing: TEXT_PRICING.claude, contextWindowTokens: 200_000 },
  { id: 'grok-chat', name: 'Grok 4.7', kind: 'text', endpoint: 'openrouter/router', inputModalities: ['text', 'image'], mediaInputMode: 'single', maxImageRefs: 16, maxTotalRefs: 16, defaults: { model: 'x-ai/grok-4.7' }, params: LLM_PARAMS, pricing: { unit: 'image', usd: 0.008 }, textPricing: TEXT_PRICING.grok, contextWindowTokens: 500_000 },
  { id: 'qwen', name: 'Qwen 3.8 Max', kind: 'text', endpoint: 'openrouter/router', inputModalities: ['text', 'image', 'video'], mediaInputMode: 'single', maxImageRefs: 16, maxVideoRefs: 16, maxTotalRefs: 16, defaults: { model: 'qwen/qwen3.8-max-0902' }, params: LLM_PARAMS, pricing: { unit: 'image', usd: 0.00016 }, textPricing: TEXT_PRICING.qwen, contextWindowTokens: 1_000_000 },
  { id: 'deepseek', name: 'DeepSeek V4.1 Flash', kind: 'text', endpoint: 'openrouter/router', inputModalities: ['text', 'image'], mediaInputMode: 'single', maxImageRefs: 16, maxTotalRefs: 16, defaults: { model: 'deepseek/deepseek-v4.1-flash', reasoning: true }, params: LLM_PARAMS, pricing: { unit: 'image', usd: 0.00122 }, textPricing: TEXT_PRICING.deepseek, contextWindowTokens: 1_048_576 },

  // ── картинки: текст → картинка (pairId → авто-переключение на *-edit при референсе) ──
  { id: 'nano-banana', name: 'Nano Banana 2', kind: 'image', endpoint: 'fal-ai/nano-banana-2', pairId: 'nano-banana-edit', defaults: { output_format: 'png' }, params: [NANO_2_ASPECT, NANO_2_RESOLUTION, NUM_IMAGES, SEED], pricing: { unit: 'image', usd: 0.08, byParam: { name: 'resolution', usd: { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 } } } },
  { id: 'nano-banana-pro', name: 'Nano Banana Pro', kind: 'image', endpoint: 'fal-ai/nano-banana-pro', pairId: 'nano-banana-pro-edit', defaults: { output_format: 'png' }, params: [NANO_PRO_ASPECT, NANO_PRO_RESOLUTION, NUM_IMAGES, SEED], pricing: { unit: 'image', usd: 0.15, byParam: { name: 'resolution', usd: { '1K': 0.15, '2K': 0.15, '4K': 0.3 } } } },
  { id: 'seedream-5-pro', name: 'Seedream 5.0 Pro', kind: 'image', endpoint: 'bytedance/seedream/v5/pro/text-to-image', pairId: 'seedream-5-pro-edit', defaults: { output_format: 'png' }, params: [SEEDREAM_ASPECT, SEEDREAM_RESOLUTION, NUM_IMAGES, SAFETY], pricing: { unit: 'image', usd: 0.135, byParam: { name: 'resolution', usd: { '1K': 0.0675, '2K': 0.135 } } } },
  { id: 'chatgpt-image-2', name: 'GPT Image 2', kind: 'image', endpoint: 'openai/gpt-image-2', pairId: 'chatgpt-image-2-edit', defaults: { output_format: 'png' }, params: [GPT_ASPECT, GPT_RESOLUTION, GPT_QUALITY, NUM_IMAGES], pricing: { unit: 'image', usd: GPT_IMAGE_2_PRICES['4:3|1K|high']!, byParam: gptQualityLadder(GPT_IMAGE_2_PRICES, '4:3'), byParams: { names: ['aspect_ratio', 'resolution', 'quality'], usd: GPT_IMAGE_2_PRICES } } },
  { id: 'grok-image', name: 'Grok Image', kind: 'image', endpoint: 'xai/grok-imagine-image', pairId: 'grok-image-edit', defaults: { output_format: 'png' }, params: [GROK_IMG_ASPECT, GROK_IMG_RESOLUTION, NUM_IMAGES], pricing: { unit: 'image', usd: 0.02 } },
  { id: 'grok-image-hq', name: 'Grok Image HQ', kind: 'image', endpoint: 'xai/grok-imagine-image/quality/text-to-image', pairId: 'grok-image-hq-edit', defaults: { output_format: 'png' }, params: [GROK_IMG_ASPECT, GROK_IMG_RESOLUTION, NUM_IMAGES], pricing: { unit: 'image', usd: 0.05, byParam: { name: 'resolution', usd: { '1k': 0.05, '2k': 0.07 } } } },

  // ── картинки: картинка(и) + текст → картинка (по референсам) ──
  { id: 'nano-banana-edit', name: 'Nano Banana 2 — by reference', kind: 'image', endpoint: 'fal-ai/nano-banana-2/edit', refs: true, maxImageRefs: 14, defaults: { output_format: 'png' }, params: [NANO_2_EDIT_ASPECT, NANO_2_RESOLUTION, NUM_IMAGES, SEED], pricing: { unit: 'image', usd: 0.08, byParam: { name: 'resolution', usd: { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 } } } },
  { id: 'nano-banana-pro-edit', name: 'Nano Banana Pro — by reference', kind: 'image', endpoint: 'fal-ai/nano-banana-pro/edit', refs: true, maxImageRefs: 14, defaults: { output_format: 'png' }, params: [NANO_PRO_EDIT_ASPECT, NANO_PRO_RESOLUTION, NUM_IMAGES, SEED], pricing: { unit: 'image', usd: 0.15, byParam: { name: 'resolution', usd: { '1K': 0.15, '2K': 0.15, '4K': 0.3 } } } },
  { id: 'seedream-5-pro-edit', name: 'Seedream 5.0 Pro — by reference', kind: 'image', endpoint: 'bytedance/seedream/v5/pro/edit', refs: true, maxImageRefs: 10, defaults: { output_format: 'png' }, params: [SEEDREAM_ASPECT, SEEDREAM_RESOLUTION, NUM_IMAGES, SAFETY], pricing: { unit: 'image', usd: 0.135, byParam: { name: 'resolution', usd: { '1K': 0.0675, '2K': 0.135 } } } },
  { id: 'chatgpt-image-2-edit', name: 'GPT Image 2 — by reference', kind: 'image', endpoint: 'openai/gpt-image-2/edit', refs: true, maxImageRefs: 16, defaults: { output_format: 'png' }, params: [GPT_EDIT_ASPECT, GPT_RESOLUTION, GPT_QUALITY, NUM_IMAGES], pricing: { unit: 'image', usd: GPT_IMAGE_2_EDIT_PRICES['auto|1K|high']!, additionalReferenceUsd: GPT_IMAGE_INPUT_IMAGE_USD, byParam: gptQualityLadder(GPT_IMAGE_2_EDIT_PRICES, 'auto'), byParams: { names: ['aspect_ratio', 'resolution', 'quality'], usd: GPT_IMAGE_2_EDIT_PRICES } } },
  { id: 'grok-image-edit', name: 'Grok Image Edit', kind: 'image', endpoint: 'xai/grok-imagine-image/edit', refs: true, maxImageRefs: 3, maxTotalRefs: 3, defaults: { output_format: 'png' }, params: [GROK_IMG_ASPECT_EDIT, GROK_IMG_RESOLUTION, NUM_IMAGES], pricing: { unit: 'image', usd: 0.022 } },
  { id: 'grok-image-hq-edit', name: 'Grok Image HQ Edit', kind: 'image', endpoint: 'xai/grok-imagine-image/quality/edit', refs: true, maxImageRefs: 3, maxTotalRefs: 3, defaults: { output_format: 'png' }, params: [GROK_IMG_ASPECT_EDIT, GROK_IMG_RESOLUTION, NUM_IMAGES], pricing: { unit: 'image', usd: 0.05, perReferenceUsd: 0.01, byParam: { name: 'resolution', usd: { '1k': 0.05, '2k': 0.07 } } } },
  { id: 'ideogram-character-edit', name: 'Ideogram 1.0', kind: 'image', endpoint: 'fal-ai/ideogram/character/edit', refs: true, canvasHidden: true, defaults: {}, params: [RENDERING_SPEED, EXPAND_PROMPT, NUM_IMAGES, SEED], pricing: { unit: 'image', usd: 0.15, byParam: { name: 'rendering_speed', usd: { TURBO: 0.1, BALANCED: 0.15, QUALITY: 0.2 } } } },

  // ── видео: текст → видео (pairId → авто-переключение на image-to-video при
  // референсе-картинке; videoPairId → на video-to-video при референсе-видео) ──
  { id: 'seedance-2', name: 'ByteDance Seedance 2.0', kind: 'video', endpoint: 'bytedance/seedance-2.0/text-to-video', pairId: 'seedance-2-i2v', videoPairId: 'seedance-2-refs', params: [SEEDANCE_RESOLUTION, SEEDANCE_DURATION, ASPECT, GENERATE_AUDIO, SEEDANCE_BITRATE], pricing: { unit: 'second', usd: 0.3034, defaultDuration: 8, byParam: { name: 'resolution', usd: { '480p': 0.141, '720p': 0.3034, '1080p': 0.682, '4k': 1.5552 } } } },
  { id: 'grok', name: 'Grok Video', kind: 'video', endpoint: 'xai/grok-imagine-video/text-to-video', pairId: 'grok-i2v', videoPairId: 'grok-video-edit', params: [GROK_ASPECT, GROK_RESOLUTION, VIDEO_DURATION], pricing: { unit: 'second', usd: 0.07, byParam: { name: 'resolution', usd: { '480p': 0.05, '720p': 0.07 } } } },
  { id: 'veo-omni', name: 'Gemini Omni Flash', kind: 'video', endpoint: 'google/gemini-omni-flash', pairId: 'veo-omni-i2v', videoPairId: 'veo-omni-video-edit', params: [VEO_ASPECT, GEMINI_DURATION], pricing: { unit: 'second', usd: 0.125 } },
  // MiniMax H3 Max. Схема сверена по openapi fal 27.08.2026.
  // ⚠️ Цена записана по ОБЫЧНОМУ тарифу ($0.05/сек 480P, $0.08/сек 768P), а не
  // по промо-скидке 50%, которая действует до 1 сентября 2026. Занизить цену
  // хуже, чем завысить: человек подтверждает запуск, глядя на эту сумму.
  { id: 'minimax-h3', name: 'MiniMax H3 Max', kind: 'video', endpoint: 'minimax/h3-max/text-to-video', pairId: 'minimax-h3-i2v', params: [H3_RESOLUTION, H3_DURATION, H3_ASPECT, H3_EXPANSION, SAFETY, SEED], pricing: { unit: 'second', usd: 0.08, defaultDuration: 5, byParam: { name: 'resolution', usd: { '480P': 0.05, '768P': 0.08 } } } },

  // ── видео: картинка → видео (оживить референс) ──
  { id: 'seedance-2-i2v', name: 'ByteDance Seedance 2.0 — first/last frame', kind: 'video', endpoint: 'bytedance/seedance-2.0/image-to-video', refs: true, maxImageRefs: 2, endImageInputField: 'end_image_url', params: [SEEDANCE_RESOLUTION, SEEDANCE_DURATION, ASPECT, GENERATE_AUDIO, SEEDANCE_BITRATE], pricing: { unit: 'second', usd: 0.3034, defaultDuration: 8, byParam: { name: 'resolution', usd: { '480p': 0.141, '720p': 0.3034, '1080p': 0.682, '4k': 1.5552 } } } },
  { id: 'veo-omni-i2v', name: 'Gemini Omni Flash — by reference', kind: 'video', endpoint: 'google/gemini-omni-flash/reference-to-video', refs: true, maxImageRefs: 10, refTagStyle: 'gemini', params: [VEO_ASPECT, GEMINI_DURATION], pricing: { unit: 'second', usd: 0.125 } },
  { id: 'grok-i2v', name: 'Grok Video', kind: 'video', endpoint: 'xai/grok-imagine-video/image-to-video', refs: true, maxImageRefs: 1, maxTotalRefs: 1, params: [GROK_I2V_ASPECT, GROK_RESOLUTION, VIDEO_DURATION], pricing: { unit: 'second', usd: 0.07, byParam: { name: 'resolution', usd: { '480p': 0.05, '720p': 0.07 } } } },
  // ⚠️ Пропорций у неё НЕТ намеренно: их задаёт сама картинка (в схеме поля
  // aspect_ratio нет). Второй референс уходит последним кадром — см.
  // endImageInputField.
  { id: 'minimax-h3-i2v', name: 'MiniMax H3 Max — first/last frame', kind: 'video', endpoint: 'minimax/h3-max/image-to-video', refs: true, maxImageRefs: 2, maxTotalRefs: 2, endImageInputField: 'end_image_url', params: [H3_RESOLUTION, H3_DURATION, H3_EXPANSION, SAFETY, SEED], pricing: { unit: 'second', usd: 0.08, defaultDuration: 5, byParam: { name: 'resolution', usd: { '480P': 0.05, '768P': 0.08 } } } },
  { id: 'grok-video-1-5', name: 'Grok Video 1.5', kind: 'video', endpoint: 'xai/grok-imagine-video/v1.5/image-to-video', refs: true, maxImageRefs: 1, maxTotalRefs: 1, params: [GROK_15_RESOLUTION, VIDEO_DURATION], pricing: { unit: 'second', usd: 0.14, perReferenceUsd: 0.01, byParam: { name: 'resolution', usd: { '480p': 0.08, '720p': 0.14, '1080p': 0.25 } } } },

  // ── видео: видео → видео (редактировать существующее видео референсом) ──
  // Sverено по openapi fal (2026-07-14). У Gemini Omni Flash video-редактирование
  // живёт на ОТДЕЛЬНОМ endpoint'е /edit (НЕ /reference-to-video — там только
  // image_urls, видео не берёт). videoInputField у каждой модели ЯВНЫЙ, не
  // угадка по имени endpoint'а — у Seedance и Gemini обе называются
  // «reference-to-video», но возможности разные.
  { id: 'seedance-2-refs', name: 'ByteDance Seedance 2.0 — by reference', kind: 'video', endpoint: 'bytedance/seedance-2.0/reference-to-video', refs: true, videoRefs: true, videoInputField: 'video_urls', audioInputField: 'audio_urls', maxImageRefs: 9, maxVideoRefs: 3, maxAudioRefs: 3, maxTotalRefs: 12, audioRequiresVisualRef: true, audioFormats: ['mp3', 'wav'], refTagStyle: 'seedance', params: [SEEDANCE_RESOLUTION, SEEDANCE_DURATION, ASPECT, GENERATE_AUDIO, SEEDANCE_BITRATE], pricing: { unit: 'second', usd: 0.3034, defaultDuration: 8, byParam: { name: 'resolution', usd: { '480p': 0.141, '720p': 0.3034, '1080p': 0.682, '4k': 1.5552 } } } },
  { id: 'grok-video-edit', name: 'Grok Video Edit', kind: 'video', endpoint: 'xai/grok-imagine-video/edit-video', refs: true, videoRefs: true, videoInputField: 'video_url', maxVideoRefs: 1, maxTotalRefs: 1, params: [GROK_EDIT_RESOLUTION], pricing: { unit: 'second', usd: 0.07, byParam: { name: 'resolution', usd: { '480p': 0.05, '720p': 0.07 } } } },
  { id: 'veo-omni-video-edit', name: 'Gemini Omni Flash — edit video', kind: 'video', endpoint: 'google/gemini-omni-flash/edit', refs: true, videoRefs: true, videoInputField: 'video_url', maxVideoRefs: 1, maxTotalRefs: 1, params: [], pricing: { unit: 'second', usd: 0.125 } },

  // ── звук: текст → звук ──
  // Схемы сверены по openapi fal 18.08.2026. У ElevenLabs поле промпта — text,
  // а не prompt (отсюда promptInputField), и обе модели отдают {audio:{url}}.
  { id: 'lyria', name: 'Lyria 2 — music', kind: 'audio', canvasHidden: true, englishPromptOnly: true, endpoint: 'fal-ai/lyria2', defaults: {}, params: [NEGATIVE_PROMPT, SEED], pricing: { unit: 'image', usd: 0.1 } },
  { id: 'eleven-tts', name: 'ElevenLabs — voiceover', kind: 'audio', canvasHidden: true, endpoint: 'fal-ai/elevenlabs/tts/turbo-v2.5', promptInputField: 'text', defaults: {}, params: [TTS_VOICE, TTS_STABILITY, TTS_SPEED], pricing: { unit: 'image', usd: 0.05, perPromptChars: 1000 }, pricingNote: 'fal charges $0.05 per 1,000 characters of text; an incomplete thousand counts as a full one.' },
  // ⚠️ Звуковые эффекты — на v2 (20.10.2026): прежний адрес
  // fal-ai/elevenlabs/sound-effects fal объявил устаревшим и неподдерживаемым.
  // Схема v2 сверена по openapi — поля, ответ и цена ($0.002 за секунду) те
  // же; новое поле loop (зацикленный звук) не выставляем, fal берёт false —
  // ровно прежнее поведение. id прежний: на него ссылаются сохранённые макросы.
  { id: 'eleven-sfx', name: 'ElevenLabs — sound effects', kind: 'audio', canvasHidden: true, endpoint: 'fal-ai/elevenlabs/sound-effects/v2', promptInputField: 'text', defaults: { output_format: 'mp3_44100_128' }, params: [SFX_DURATION, SFX_INFLUENCE], pricing: { unit: 'second', usd: 0.002, durationParam: 'duration_seconds', defaultDuration: 22 } },

  // ⚠️ Цены звуковых моделей взяты из ЖИВОЙ истории трат fal (20.08.2026), а
  // не из прикидки: у Lyria стояло 0.06, реально списалось 0.1, а у разделения
  // дорожки цены не было вовсе — кнопка говорила «Создать» без суммы, хотя
  // операция платная. В openapi цен нет, проверять их можно только так:
  // GET /api/fal-history после прогона.
  // Разделение дорожки: единственная звуковая модель, доступная с канваса
  // (решение пользователя 19.08.2026). Она НЕ генерирует звук, а достаёт из
  // него то, что описано промптом («голос», «гитара»), поэтому без выделенного
  // аудио запускать нечего — отсюда minAudioRefs. Модель отдаёт ДВЕ дорожки,
  // на холст кладём target (см. resultFrom в fal.ts).
  { id: 'sam-audio-separate', name: 'SAM Audio — extract track', kind: 'audio', endpoint: 'fal-ai/sam-audio/separate', refs: true, audioInputField: 'audio_url', minAudioRefs: 1, maxAudioRefs: 1, maxTotalRefs: 1, audioFormats: ['mp3', 'wav'], defaults: {}, params: [SEPARATE_FORMAT, SEPARATE_ACCELERATION, SEPARATE_CANDIDATES], pricing: { unit: 'image', usd: 0.05 } },

  // ── другое ──
  { id: 'sam-image', name: 'SAM 3', kind: 'other', endpoint: 'fal-ai/sam-3/image', refs: true, promptInputField: 'text_prompt', maxImageRefs: 1, maxTotalRefs: 1, defaults: { output_format: 'png' }, params: [APPLY_MASK, RETURN_MULTIPLE_MASKS, MAX_MASKS, INCLUDE_SCORES, INCLUDE_BOXES, OUTPUT_FORMAT], pricing: { unit: 'image', usd: 0.01 } },
  { id: 'seedvr-seamless-upscale', name: 'SeedVR2 Seamless Upscale', kind: 'other', endpoint: 'fal-ai/seedvr/upscale/image/seamless', refs: true, promptInputField: null, seedOutput: true, minImageRefs: 1, maxImageRefs: 1, maxTotalRefs: 1, defaults: { sync_mode: false }, params: [UPSCALE_MODE, UPSCALE_FACTOR, TARGET_RESOLUTION, SEED, NOISE_SCALE, SAFETY, OUTPUT_FORMAT], pricing: { unit: 'image', usd: 0.020736, perOutputMegapixel: 0.0025 }, pricingNote: 'fal charges $0.0025 per megapixel of the upscaled image.' },
]

// дефолтная модель для каждого типа (когда конкретная не выбрана — напр. с канваса)
CATALOG.push(...GPT_25_MODELS)
for (const model of CATALOG) {
  model.contractRevision ??= CATALOG_REVISION
  model.adapterVersion ??= ADAPTER_VERSION
  model.minExecutorVersion ??= 1
  model.lifecycle ??= 'active'
}

export const DEFAULT_MODEL: Record<ModelKind, CatalogModel> = {
  image: CATALOG.find((m) => m.id === 'nano-banana')!,
  video: CATALOG.find((m) => m.id === 'seedance-2')!,
  text: CATALOG.find((m) => m.id === 'gemini')!,
  audio: CATALOG.find((m) => m.id === 'sam-audio-separate')!,
  other: CATALOG.find((m) => m.id === 'sam-image')!,
}

// дефолтная модель для картинки/видео с референсами
export const DEFAULT_REF_MODEL: Partial<Record<ModelKind, CatalogModel>> = {
  image: CATALOG.find((m) => m.id === 'nano-banana-edit')!,
  video: CATALOG.find((m) => m.id === 'seedance-2-i2v')!,
}

const byId = new Map(CATALOG.map((m) => [m.id, m]))

export function replaceRuntimeCatalog(models: readonly CatalogModel[]): void {
  CATALOG.splice(0, CATALOG.length, ...models)
  byId.clear()
  for (const model of CATALOG) byId.set(model.id, model)
}

// Из строки/официальной fal.ai-ссылки вытаскиваем только endpoint-id.
// Полный URL никогда не передаётся SDK: иначе его Authorization мог уйти
// на похожий домен вроде evilfal.ai.
const STOP_WORDS = new Set(['api', 'playground', 'docs', 'examples', 'requests', 'logs', 'analytics', 'settings'])
const ENDPOINT_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function cleanEndpointId(input: string): string {
  const rawParts = input.split('/').filter(Boolean)
  const markers = new Set(['models', 'model', 'endpoints', 'endpoint'])
  const start = rawParts.findIndex((part) => markers.has(part.toLowerCase()))
  const parts = start >= 0 ? rawParts.slice(start + 1) : rawParts
  while (parts.length > 0 && STOP_WORDS.has(parts[parts.length - 1].toLowerCase())) parts.pop()
  if (parts.length < 2 || parts.length > 8 || parts.some((part) => !ENDPOINT_PART_RE.test(part))) return ''
  return parts.join('/')
}

export function normalizeEndpoint(input: string): string {
  let value = input.trim()
  if (!value) return ''
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value)
      if (url.protocol !== 'https:' || (url.hostname !== 'fal.ai' && url.hostname !== 'www.fal.ai')) return ''
      const q = url.searchParams
      const fromQuery = q.get('endpoint') || q.get('model') || q.get('model_id') || q.get('model_name')
      if (fromQuery) return cleanEndpointId(fromQuery)
      value = url.pathname
    }
  } catch {
    return ''
  }
  return cleanEndpointId(value)
}

// Тип выхода по endpoint-строке (порт inferFalModelType, компактно).
export function inferKind(endpoint: string): ModelKind {
  const t = endpoint.toLowerCase()
  if (/(sam-3|segment|sam)/.test(t)) return 'other'
  if (/(lipsync|lip-sync|talking|avatar|foley|video-to-audio)/.test(t)) return 'video'
  if (/(video|veo|kling|wan|ltx|luma|ray|motion|animate|seedance|sora|hunyuan|grok-imagine.*video|omni-flash|first-last-frame|reference-to-video|edit-video)/.test(t))
    return 'video'
  if (/(image-edit|edit|kontext|flux|hidream|seedream|gpt-image|qwen-image|imagen|nano-banana|chroma|z-image|recraft|photon)/.test(t))
    return 'image'
  // Звук стал своим типом (раньше выдавался за видео, чтобы хоть куда-то лечь).
  // Проверка идёт ПОСЛЕ видео: mmaudio и липсинк принимают звук, но отдают
  // видео, и по одному слову «audio» в имени их не отличить.
  if (/(audio|tts|speech|voice|music|sound|lyria)/.test(t)) return 'audio'
  if (/(llm|chat|text|language|any-llm|openrouter\/router)/.test(t)) return 'text'
  return 'image'
}

// Разрешает модель: по id из каталога, либо по произвольному endpoint'у/URL.
export interface ResolvedModel {
  endpoint: string
  kind: ModelKind
  refs: boolean
  // как передавать референсы: 'image_url' (одна картинка — обычное
  // image-to-video) или 'image_urls' (массив — image-edit / reference-to-video)
  imageInput: 'image_url' | 'image_urls'
  // видео-референс: 'video_url' (edit-video, одно видео) или 'video_urls'
  // (reference-to-video, массив); null — модель видео на вход не берёт
  videoInput: 'video_url' | 'video_urls' | null
  // Аудиореференсы задаются только явным контрактом каталога.
  audioInput: 'audio_url' | 'audio_urls' | null
  // Куда класть ВТОРОЙ кадр (первый/последний); null — модель этого не умеет.
  endImageInput: 'end_image_url' | null
  promptInput: 'prompt' | 'text_prompt' | 'text' | null
  // синтаксис inline-ссылок на референсы (@n → тег модели); null — не поддерживает
  refTagStyle: 'gemini' | 'seedance' | null
  defaults: Record<string, unknown>
}

// дефолты из настраиваемых параметров модели (применяются всегда)
function paramDefaults(m: CatalogModel): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of m.params ?? []) {
    if (p.default !== undefined && !(p.widget === 'seed' && p.default === -1)) out[p.name] = p.default
  }
  return out
}

// reference-to-video и image-edit принимают массив `image_urls`, обычное
// image-to-video — одну `image_url`; картинки-модели всегда массив
function inferImageInput(endpoint: string, kind: ModelKind): 'image_url' | 'image_urls' {
  if (kind === 'image') return 'image_urls'
  return /reference-to-video/.test(endpoint) ? 'image_urls' : 'image_url'
}

// Только для «своего endpoint'а» (нет записи в каталоге, значит нет и явного
// videoInputField) — очень узкий, однозначный паттерн video-to-video edit.
// НЕ угадываем по «reference-to-video»: у Seedance это video_urls, у Gemini
// Omni Flash под тем же названием — только картинки (см. видео-модели ниже).
function inferVideoInput(endpoint: string, kind: ModelKind): 'video_url' | 'video_urls' | null {
  if (kind !== 'video') return null
  return /edit-video/.test(endpoint) ? 'video_url' : null
}

export function resolveCatalogPreset(m: CatalogModel): ResolvedModel {
  return {
    endpoint: m.endpoint,
    kind: m.kind,
    refs: Boolean(m.refs),
    imageInput: m.imageInputField ?? inferImageInput(m.endpoint, m.kind),
    // явное поле каталога — в приоритете; инференс только как фолбэк
    videoInput: m.videoInputField ?? inferVideoInput(m.endpoint, m.kind),
    audioInput: m.audioInputField ?? null,
    endImageInput: m.endImageInputField ?? null,
    promptInput: m.promptInputField === undefined ? 'prompt' : m.promptInputField,
    refTagStyle: m.refTagStyle ?? null,
    defaults: { ...paramDefaults(m), ...(m.defaults ?? {}) },
  }
}

export function resolveModel(
  model: string | undefined,
  fallbackKind: ModelKind,
  withRefs: boolean,
  withVideoRef = false,
  withAudioRef = false,
  // Сколько картинок-референсов: от числа зависит вариант семьи (imageCapacity.ts).
  imageRefCount = withRefs ? 1 : 0,
): ResolvedModel {
  // 1) выбран пресет из каталога
  if (model && byId.has(model)) {
    let preset = byId.get(model)!
    if (withVideoRef || withAudioRef) {
      const family = CATALOG.find(candidate => candidate.pairId === preset.id || candidate.videoPairId === preset.id)
      const videoPairId = preset.videoPairId ?? family?.videoPairId
      // есть видео-референс → её video-ref-вариант (приоритет выше image-pairId)
      if (videoPairId && byId.has(videoPairId)) {
        preset = byId.get(videoPairId)!
      } else if (!preset.videoRefs || (withAudioRef && !preset.audioInputField)) {
        // выбранная модель видео на вход не берёт — переключаем на ту, что умеет
        const alt = CATALOG.find(
          (m) =>
            m.kind === fallbackKind &&
            m.videoRefs &&
            (!withAudioRef || Boolean(m.audioInputField)),
        )
        if (alt) preset = alt
      }
    } else if (withRefs) {
      // есть картинка-референс, но выбрана базовая (text→X) модель → её ref-вариант
      if (!preset.refs && preset.pairId && byId.has(preset.pairId)) preset = byId.get(preset.pairId)!
      // картинок больше, чем он берёт, — вариант семьи, который их возьмёт
      preset = variantForImageCount(CATALOG, preset, imageRefCount)
    }
    return resolveCatalogPreset(preset)
  }
  // 2) свой endpoint (или ссылка)
  if (model && model.trim()) {
    const endpoint = normalizeEndpoint(model)
    if (endpoint) {
      const kind = inferKind(endpoint)
      return { endpoint, kind, refs: withRefs, imageInput: inferImageInput(endpoint, kind), videoInput: inferVideoInput(endpoint, kind), audioInput: null, endImageInput: null, promptInput: 'prompt', refTagStyle: null, defaults: {} }
    }
  }
  // 3) ничего не задано — дефолт по типу (поведение канваса)
  if (withVideoRef || withAudioRef) {
    const videoModel = CATALOG.find(
      (m) =>
        m.kind === fallbackKind &&
        m.videoRefs &&
        (!withAudioRef || Boolean(m.audioInputField)),
    )
    if (videoModel) return resolveCatalogPreset(videoModel)
  }
  const preset = (withRefs && DEFAULT_REF_MODEL[fallbackKind]) || DEFAULT_MODEL[fallbackKind]
  return resolveCatalogPreset(withRefs ? variantForImageCount(CATALOG, preset, imageRefCount) : preset)
}
