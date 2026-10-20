export type JobKind = 'image' | 'video' | 'text' | 'audio' | 'other'
export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface JobResult {
  // картинки/видео
  assetId?: string
  assetRevision?: number
  assetChecksum?: string
  url?: string
  width?: number
  height?: number
  mime?: string
  // текст (LLM)
  text?: string
  seed?: number
}

export interface Job {
  id: string
  kind: JobKind
  prompt: string
  status: JobStatus
  progressText?: string
  result?: JobResult
  error?: string
  /** Номер той же задачи у сервера команды — появляется, когда она туда ушла. */
  cloudJobId?: string
  /** Cloud billing metadata; present only for metered public jobs. */
  pricingMode?: PricingMode
  priceUsd?: number
  chargedAmountUsd?: number | null
}

export interface ServerStatus {
  falConfigured: boolean
  /** A backup recovery still needs review; automatic media cleanup is paused. */
  recoveryNeedsReview?: boolean
  /** Есть действующий парольный сеанс CanAI-cloud. */
  accountCloudConfigured?: boolean
  mockMode: boolean
  serverFingerprint?: string | null
  /** Какая сборка у сервера (пункт 5.1); у старого сервера поля нет. */
  build?: { version: string; commit: string | null; date: string | null; dirty?: boolean }
}

/** Способ расчёта цены, который может сообщить Cloud-каталог или quote. */
export type PricingMode = 'fixed' | 'provider-cost' | 'fal-metered'

/** Точная цена cloud-запроса, выданная сервером команды до submit. */
export interface GenerationQuote {
  id: string
  requestHash: string
  amountMicro: number
  amountUsd: number
  quantity: number
  expiresAt: number
  needsConfirmation: boolean
  contractRevision?: string
  tariffRevision?: string
  guaranteed?: boolean
  /** `fal-metered` quote is settled by provider cost without a cap. */
  meteredUncapped?: boolean
  /** General team confirmation threshold in micro-dollars; `0` disables it. */
  confirmAboveMicro?: number
  /** `fal-metered` with guaranteed=true is a reserve ceiling, not a fixed price. */
  pricingMode?: PricingMode
}

export interface GenerationQuoteResponse {
  quote: GenerationQuote | null
  idempotencyKey: string
}

// описание настраиваемого параметра модели (поле формы на ноде)
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
  /**
   * Сервер команды: «Авто» допустимо, только когда подключён референс (у Grok
   * Image HQ его знает лишь операция «по референсам»). В `options` его нет
   * намеренно — промпт-бар показал бы «Авто» и без референса. Читает это нода
   * (`nodeAspect.ts`).
   */
  autoWithRefs?: boolean
}

export interface TextTokenPricing {
  inputPerMillion: number
  outputPerMillion: number
  cachedInputPerMillion?: number
  checkedAt: string
}

export interface MediaPricing {
  unit: 'image' | 'second'
  usd: number
  defaultDuration?: number
  /** Параметр длительности посекундной модели; по умолчанию `duration`. */
  durationParam?: string
  /** `usd` за каждые столько знаков текста; неполная тысяча — целая. */
  perPromptChars?: number
  /** Цена за мегапиксель РЕЗУЛЬТАТА (апскейл); размер — по входу и ручкам upscale_*. */
  perOutputMegapixel?: number
  perReferenceUsd?: number
  additionalReferenceUsd?: number
  byParam?: {
    name: string
    usd: Record<string, number>
  }
  byParams?: {
    names: string[]
    usd: Record<string, number>
  }
  /**
   * Цена ЗАПУСКА целиком (не за секунду) — у посекундных моделей сетевой
   * доски. Сервер команды считает её той же функцией, что и котировку: из
   * округлённой ставки за секунду её не получить (см. cloudCatalogModel).
   */
  perLaunch?: {
    names: string[]
    usd: Record<string, number>
  }
}

// модель из каталога fal (для выбора в нодах)
export interface CatalogDefaults {
  image: string | null
  video: string | null
  audio: string | null
  assistant: string | null
}

export type ModelLifecycle = 'active' | 'archived' | 'disabled'

export interface CatalogModel {
  contractRevision?: string
  adapterVersion?: number
  minExecutorVersion?: number
  lifecycle?: 'active' | 'archived' | 'disabled'
  pricingNote?: string
  /** Для Cloud-моделей `fal-metered` — режим расчёта по провайдеру. */
  pricingMode?: PricingMode
  /** `fal-metered` model is settled by actual provider cost without a cap. */
  meteredUncapped?: boolean
  id: string
  name: string
  kind: JobKind
  endpoint?: string
  refs: boolean
  // у базовой модели — id её ref-варианта (edit / image-to-video)
  pairId?: string
  // умеет принимать ВИДЕО-референс (video-to-video редактирование)
  videoRefs?: boolean
  // у базовой видео-модели — id её видео-ref-варианта
  videoPairId?: string
  // поддерживает ли inline-ссылки на референсы (@n) и в каком синтаксисе;
  // null/нет — не поддерживает (клиент подскажет описывать словами)
  refTagStyle?: 'gemini' | 'seedance' | null
  // скрыть из дропдауна канваса, но оставить доступной в нодах
  canvasHidden?: boolean
  /** Модель принимает промпт только по-английски (Lyria). */
  englishPromptOnly?: boolean
  pricing?: MediaPricing
  textPricing?: TextTokenPricing
  contextWindowTokens?: number
  inputModalities?: Array<'text' | 'image' | 'video' | 'audio'>
  mediaInputMode?: 'single' | 'mixed'
  /** Provider schema requires image, video, or PDF context when no image list is sent. */
  conditionalReferenceRequirement?: 'image-or-video-or-pdf'
  maxImageRefs?: number
  minImageRefs?: number
  /** Разделению дорожки нужен выделенный звук — без него запускать нечего. */
  minAudioRefs?: number
  maxVideoRefs?: number
  minVideoRefs?: number
  maxAudioRefs?: number
  maxTotalRefs?: number
  audioRequiresVisualRef?: boolean
  audioFormats?: string[]
  promptRequired?: boolean
  seedOutput?: boolean
  imageInputField?: 'image_url' | 'image_urls'
  videoInputField?: 'video_url' | 'video_urls'
  audioInputField?: 'audio_url' | 'audio_urls'
  endImageInputField?: 'end_image_url'
  promptInputField?: 'prompt' | 'text_prompt' | 'text' | null
  defaults?: Record<string, string | number | boolean>
  params: ParamSpec[]
}

export type GenRef =
  | { kind: 'image'; src: string; assetId?: string; width?: number; height?: number; role?: string }
  | { kind: 'video'; src: string; assetId?: string; width?: number; height?: number; role?: string }
  | { kind: 'audio'; src: string; assetId?: string; role?: string }
  | { kind: 'text'; text: string }

export interface CatalogDraftTestReceipt {
  jobId: string
  completedAt: number
  resultKind: 'image' | 'video' | 'audio' | 'text'
  actualCostUsd: number | null
  definitionHash: string
  tariffHash: string
}

export interface CatalogDraftMeta {
  tariffSourceUrl?: string
  tariffConfirmedAt?: number
  definitionHash?: string
  tariffHash?: string
  testInvalidatedAt?: number
  test?: CatalogDraftTestReceipt
}

export interface CatalogLibraryView {
  revision: number
  release: string
  models: CatalogModel[]
  drafts: CatalogModel[]
  defaults: CatalogDefaults
  draftMeta: Record<string, CatalogDraftMeta>
  defaultIssues: string[]
}

export interface LifecycleMacroImpact {
  id: string
  name: string
  revision: number
  nodeIds: string[]
}

export interface LifecyclePlan {
  operationId: string
  modelId: string
  target: ModelLifecycle
  catalogRevision: number
  familyIds: string[]
  affectedDefaults: Array<keyof CatalogDefaults>
  macros: LifecycleMacroImpact[]
  replacementModels: Array<Pick<CatalogModel, 'id' | 'name' | 'kind'>>
}

export interface ApplyLifecycleInput {
  operationId: string
  defaultReplacements: Partial<CatalogDefaults>
  macroReplacements: Record<string, string>
}

export interface DraftTariffInput {
  pricing?: MediaPricing
  textPricing?: TextTokenPricing
  tariffSourceUrl: string
}

export interface DraftTestInput {
  prompt: string
  refs: GenRef[]
  params: Record<string, unknown>
  confirmedAmountUsd?: number
}

export interface CatalogDraftSetupSample {
  kind: 'image' | 'video' | 'audio'
  name: string
  url: string
}

export interface CatalogDraftSetupPricing {
  sourceUrl: string
  note: string
  amountUsd: number
  approximate: boolean
  unit?: string
}

export interface CatalogDraftSetupResponse {
  library: CatalogLibraryView
  input: {
    prompt: string
    refs: GenRef[]
    params: Record<string, unknown>
  }
  pricing: CatalogDraftSetupPricing | null
  samples: CatalogDraftSetupSample[]
  warnings: string[]
}

export interface DraftTestQuote {
  amountUsd: number
  requiresConfirmation: boolean
  definitionHash: string
  tariffHash: string
}

export interface DraftTestStatus {
  jobId: string
  status: Job['status']
  result?: JobResult
  error?: string
  actualCostUsd: number | null
}

export interface DiscoverCatalogModelResult {
  library?: CatalogLibraryView
  existingModel?: string
  issues: string[]
}

// --- Непрерывность сеанса между устройствами ---
// Доска, камера и заглушки генераций переезжают сами (они в project.json);
// эти два типа отвечают за остальное: положение рычагов и то, кто за рулём.

export interface SessionDraftRef {
  id: string
  kind: 'image' | 'video' | 'audio' | 'text'
  src?: string
  text?: string
  name?: string
}

export interface SessionDraft {
  prompt: string
  kind: 'image' | 'video' | 'audio'
  modelId?: string
  params?: Record<string, string | number | boolean>
  count?: number
  pane?: 'prompt' | 'assistant'
  selection?: string[]
  manualRefs?: SessionDraftRef[]
}

export interface BoardHolder {
  clientId: string
  device: string
  since: number
  lastSeen: number
}

export interface RemoteAccessInfo {
  enabled: boolean
  pinSet: boolean
  devices: Array<{ device: string; createdAt: number }>
  server: {
    running: boolean
    lan: boolean
    port: number
    addresses: string[]
    /** Адреса вместе с именем сетевого подключения. Поле новое: старый
     *  сервер его не пришлёт, тогда показываем просто addresses. */
    links?: Array<{ url: string; name: string; virtual: boolean }>
    /** Система компьютера — по ней решаем, говорить ли про брандмауэр. */
    platform?: string
    error: string | null
  }
}


/** Эфемерное подключение планшета к одной локальной доске через relay. */
export interface CloudTabletPairingInfo {
  active: boolean
  connected: boolean
  sessionId?: string
  projectId?: string
  expiresAt?: number
  /** Одноразовая ссылка находится только в памяти и никогда не пишется в настройки. */
  qr?: string
  error?: string
}

export type ProjectSource = 'local' | 'cloud'

export interface ProjectRef {
  source: ProjectSource
  id: string
}

export interface CloudAccountSummary {
  connected: boolean
  reachable: boolean
  /** Opaque scope for pending network-board commands in this browser. */
  journalScope?: string
  mustChangePassword?: boolean
  serverUrl?: string
  message?: string
  team?: { id: string; name: string }
  member?: {
    id: string
    name: string
    emailHint: string
    role: 'lead' | 'senior' | 'performer'
  }
  device?: { id: string; name: string }
  /**
   * Поломка сервера, о которой должен узнать человек, а не только лог. Приходит
   * вместе с профилем: отдельного канала для этого не осталось, а профиль
   * приложение и так спрашивает.
   */
  serverAlert?: { kind: 'storage-buffer'; state: 'degraded' | 'blocked'; percent: number }
  /**
   * Вход сбросил СЕРВЕР, а не человек (жалоба 22.09.2026: сетевые доски молча
   * пропали из галереи). Приходит только при `connected: false`.
   */
  signedOut?: { at: number; message: string }
  /**
   * Сколько денег осталось на сегодня по пределам, которые задал тимлид.
   *
   * ⚠️ Пределов два и они разные: у команды общий на всех, у рабочего места —
   * свой. Кончиться может любой, поэтому показываем тот, что ближе к концу.
   */
  budget?: {
    team?: { limitUsd: number; spentUsd: number; leftUsd: number }
    device?: { limitUsd: number; spentUsd: number; leftUsd: number }
  }
}

export type CloudMemberRole = NonNullable<CloudAccountSummary['member']>['role']
export type CloudServerAlert = NonNullable<CloudAccountSummary['serverAlert']>
