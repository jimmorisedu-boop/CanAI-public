// Модель холста на Konva. Своя сериализация: в проекте ТОЛЬКО ссылки
// /media/… и метаданные — никаких base64 (священный инвариант CanAI).
import type { GenerationRetryDescriptor } from '../generationRegistry'
import type { GenerationLaunchMeta } from '../generationLaunches'
import type { MediaLinkPreview } from '../mediaImportTypes'

export type ItemKind = 'image' | 'video' | 'text' | 'link' | 'audio'

export interface CanvasLinkData extends MediaLinkPreview {
  url: string
  state: 'loading-preview' | 'ready' | 'error'
  error?: string
  /** Отказ из-за входа на площадку: карточка предлагает войти, а не повторять. */
  needsLogin?: boolean
  /**
   * Ошибка ничего не говорит о самой ссылке: CanAI не ответил вовремя. Такая
   * карточка запрашивает превью снова сама при следующем открытии доски
   * (`transientLinkError`).
   */
  transientError?: boolean
  activeImportId?: string
  downloadedItemIds?: Record<string, string>
}

export interface CanvasCrop {
  sourceSrc?: string
  /** Stable logical identity in a Cloud board; sourceSrc is derived locally. */
  sourceAssetId?: string
  sourceMime?: string
  sourceNaturalWidth: number
  sourceNaturalHeight: number
  rect: { x: number; y: number; w: number; h: number }
}

export interface CanvasItem {
  id: string
  kind: ItemKind
  x: number
  y: number
  w: number
  h: number
  rotation?: number
  // image | video
  src?: string
  /** Stable logical identity in a Cloud board; src is never synchronized. */
  assetId?: string
  /** Server-owned asset revision/checksum used for exact agent input capture. */
  assetRevision?: number
  assetChecksum?: string
  mime?: string
  naturalWidth?: number
  naturalHeight?: number
  // Неразрушающий кроп: src остаётся видимым/скачиваемым результатом,
  // а crop хранит исходник и рамку для последующего расширения.
  crop?: CanvasCrop
  // audio: длительность в секундах — плашке нечего показать, кроме имени и её
  // (ширина/высота у звука произвольные, натуральных размеров у него нет)
  duration?: number
  // высоты столбиков волны 0..100, считает сервер один раз (см. audioPeaks.ts);
  // может не быть — тогда плашка рисуется без волны, и это норма
  peaks?: number[]
  // видео без звука: кнопка на самом объекте. Поле обычное, поэтому состояние
  // переживает и уход объекта за край экрана (культинг размонтирует фигуру),
  // и перезагрузку доски
  muted?: boolean
  // text
  text?: string
  fontSize?: number // растёт при ресайзе за угол (см. stepTextTransform); без поля — DEFAULT_FONT_SIZE
  // link
  link?: CanvasLinkData
  // подпись (имя ассета)
  name?: string
  // метаданные генерации
  prompt?: string
  modelId?: string
  referenceIds?: string[]
  sourceJobId?: string
  sourceLaunch?: GenerationLaunchMeta
  // Durable identity of a result produced by one external-editor session.
  externalEditSessionId?: string
  // метка группового экспорта (1..999) — см. setMarks/zipExport
  mark?: number
  // Происхождение кадра, снятого из клипа в таймлайне (раздел 11 ТЗ).
  // Хранится в metadata объекта, а не в URL/localStorage. Старые проекты без
  // него открываются и рендерятся как обычно.
  timelineCapture?: {
    /** Стабильный id/источник доски, если доступен. */
    originBoard?: string
    /** id исходного видео CanvasItem. */
    originItemId: string
    /** asset id исходного клипа при наличии. */
    originAssetId?: string
    /** revision исходного бинаря при наличии. */
    originAssetRevision?: number
    /** checksum исходного бинаря при наличии. */
    originChecksum?: string
    /** Точное запрошенное время кадра в секундах. */
    time: number
    /** id созданного CanvasItem после commit, если известен. */
    resultItemId?: string
    /** asset id результата после upload, если известен. */
    resultAssetId?: string
    /** Дата — только для UI-аудита, НЕ для дедупликации. */
    createdAt: number
  }
}

// Заархивированный объект: снят с холста, но НЕ потерян. Хранит всё, что нужно
// и для возврата на прежнее место (x/y/w/h), и для просмотра в панели архива.
// Как и везде в CanAI — только ссылка /media/… и метаданные, без base64.
export interface ArchivedItem extends CanvasItem {
  archivedAt: number // Date.now() в момент отправки в архив (сортировка «по дате»)
}

export interface CanvasCamera {
  x: number
  y: number
  scale: number
}

// Закреплённый ассет — «полка быстрого доступа» справа. Только ссылка на
// media (без base64), живёт в доске. slot 0..N-1 = позиция кнопки.
export interface PinnedAsset {
  slot: number
  kind: 'image' | 'video' | 'text' | 'audio'
  src?: string
  assetId?: string
  assetRevision?: number
  assetChecksum?: string
  mime?: string
  text?: string
  name?: string
  width?: number
  height?: number
}

export interface CanvasDoc {
  version: 1
  items: CanvasItem[]
  camera: CanvasCamera
  assets?: PinnedAsset[]
  // архив доски: убранный с холста материал, который может понадобиться
  archive?: ArchivedItem[]
  // Восстанавливаем только самостоятельные canvas-jobs с настоящим jobId.
  // Временные workflow-placeholder'ы в снапшот не попадают.
  pending?: Placeholder[]
  // Уже обработанные серии генерации: не показываем auto reveal повторно после reload.
  handledGenerationLaunchIds?: string[]
}

// штрих скетча (в мировых координатах) — не хранится в проекте, живёт
// только пока открыт режим скетча
export interface SketchStroke {
  points: number[] // [x0,y0,x1,y1,…] в мировых координатах
  color: string
  size: number
  tool?: 'draw' | 'erase'
}

// Заглушка «будущего результата»: карточка со спиннером на месте, где появится
// сгенерированный контент. Canvas-jobs с настоящим jobId переживают reload;
// transient-заглушки workflow остаются только в памяти. В историю не попадает.
export interface Placeholder {
  id: string
  jobId?: string // связь с задачей генерации (проставляется после api.generate)
  x: number
  y: number
  w: number
  h: number
  kind: 'image' | 'video' | 'audio'
  label: string // имя модели — показываем, пока крутится
  status: 'loading' | 'error'
  error?: string
  startedAt: number // для счётчика секунд
  prompt?: string
  modelId?: string
  referenceIds?: string[]
  // хотя бы один непустой ref действительно ушёл в api.generate
  usedReferences?: boolean
  launch?: GenerationLaunchMeta
  retry?: GenerationRetryDescriptor
  transient?: boolean
  taskType?: 'generation' | 'media-import'
  importEntryId?: string
  sourceLinkId?: string
  downloadedBytes?: number
  totalBytes?: number
  percent?: number
  stage?: string
  /**
   * Сама работа, пока она едет на сервер (карточка своей работы, пункт 3.6):
   * результат виден сразу, а не после загрузки. Адрес на этом компьютере —
   * наружу не уезжает (LOCAL_ONLY_KEYS) и бывает только у `transient`.
   */
  previewSrc?: string
  /** Кусок картинки `previewSrc` в её натуральных пикселях (обрезка). */
  previewCrop?: { x: number; y: number; width: number; height: number }
  /** Поворот карточки — как у объекта, на месте которого она стоит. */
  rotation?: number
}

export const EMPTY_DOC: CanvasDoc = {
  version: 1,
  items: [],
  camera: { x: 0, y: 0, scale: 1 },
}

export type {
  CanvasMutation,
  CanvasMutationEnvelope,
  CanvasMutationPort,
} from './canvasMutations'
