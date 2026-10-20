// Чистая математика полноэкранного таймлайна: зум, границы пана, различие
// fit/100% и ключи захвата кадра.
//
// Вся она детерминированная и не читает глобальный window — поэтому её можно
// проверить без DOM и без браузера (см. timelineCanvasMath.test.ts). Всё, что
// зависит от живого <video>, остаётся в captureFrame.ts и TimelineOverlay;
// сюда попадает только то, что можно и нужно покрыть тестом.

export interface Viewport { width: number; height: number }
export interface ContentBox { width: number; height: number }

/** Потолок зума: «100%» у крупного оригинала в маленькой рамке — это легко
 *  10× и больше. Тот же предел, что у useSharedZoom. */
export const MIN_SCALE = 1
export const MAX_SCALE = 24

const WHEEL_FACTOR = 1.15

/**
 * Нормализовать дельту wheel в ограниченный signed сдвиг.
 *
 * Превью перехватывает wheel нативным слушателем (React слушает его пассивно),
 * а здесь только чистое приведение. deltaMode разводится на пиксели, строки и
 * страницы так, чтобы шаг был сопоставим:
 *   pixels (0) — знак и величина дельты;
 *   lines (1)  — одна строка ≈ 16 px (browser default 3 строки на щелчок);
 *   page (2)   — одна страница ≈ half viewport.
 */
export function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewport?: Viewport,
): number {
  if (deltaMode === 2) {
    const base = viewport && viewport.height > 0 ? viewport.height / 2 : 300
    return deltaY > 0 ? base : -base
  }
  if (deltaMode === 1) {
    return deltaY * 16
  }
  return deltaY
}

/** Множитель зума по знаку нормализованной дельты (wheel 1.15, как в сравнении). */
export function wheelScaleFactor(deltaY: number, viewport?: Viewport): number {
  const normalized = normalizeWheelDelta(deltaY, 0, viewport)
  return normalized < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR
}

/** Ограничить запрошенный масштаб диапазоном. */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export interface ZoomView {
  scale: number
  x: number
  y: number
}

const IDENTITY: ZoomView = { scale: 1, x: 0, y: 0 }

export const IDENTITY_ZOOM: ZoomView = IDENTITY

/**
 * Зум к точке: точка содержимого, что была под курсором, остаётся под ним
 * после изменения масштаба. `prev` — текущий zoom, `nextScale` — целевой,
 * `point` — позиция курсора в координатах viewport, `frame` — размер рамки
 * контента.
 */
export function zoomAtPoint(
  prev: ZoomView,
  nextScale: number,
  point: { x: number; y: number },
  frame: { width: number; height: number },
): ZoomView {
  const scale = clampScale(nextScale)
  if (scale <= 1.001) return { ...IDENTITY }
  const cx = frame.width / 2
  const cy = frame.height / 2
  // где эта точка лежит в невзумленных координатах рамки
  const fitX = cx + (point.x - cx - prev.x) / prev.scale
  const fitY = cy + (point.y - cy - prev.y) / prev.scale
  return {
    scale,
    x: point.x - cx - (fitX - cx) * scale,
    y: point.y - cy - (fitY - cy) * scale,
  }
}

/**
 * Сколько кадр можно сдвинуть от центра по каждой оси при данном масштабе.
 *
 * `content` — размер кадра БЕЗ масштаба (то, что видно при «вписано»),
 * `viewport` — окно. Кадр шириной scale·content выходит за окно на разницу, и
 * сдвигать его можно ровно на половину этой разницы в каждую сторону — дальше
 * показалась бы пустота. Нулевой предел — кадр по этой оси помещается в окно
 * и стоит по центру (или масштаб 1: сдвигать нечего).
 *
 * ⚠️ Это ПРЕДЕЛ (ширина допустимого коридора), а не зажатое смещение: хук
 * зума (`useSharedZoom`) ждёт именно предел и сам зажимает им пан. Прежняя
 * проводка отдавала ему `clampPan(scale, {0, 0}, …)` — то есть смещение нуля,
 * которое всегда {0, 0}, — и пан намертво зажимался в центр: двойной клик «в
 * точку» и перетаскивание приближённого кадра не делали ничего.
 */
export function panLimits(
  scale: number,
  viewport: Viewport,
  content: ContentBox,
): { x: number; y: number } {
  if (!(scale > 1.001)) return { x: 0, y: 0 }
  return {
    x: Math.max(0, (content.width * scale - viewport.width) / 2),
    y: Math.max(0, (content.height * scale - viewport.height) / 2),
  }
}

/**
 * Ограничить пан, чтобы видимый stage не оставлял бесконечный пустой край.
 *
 * `content` — размер кадра без масштаба, `viewport` — окно. Допустимый сдвиг —
 * `panLimits` (по каждой оси ровно (scale·content − viewport)/2, с нулём, когда
 * кадр меньше окна или масштаб 1). NaN лечится в ноль.
 */
export function clampPan(
  scale: number,
  pan: { x: number; y: number },
  viewport: Viewport,
  content: ContentBox,
): { x: number; y: number } {
  const limit = panLimits(scale, viewport, content)
  const x = Number.isFinite(pan.x) ? Math.max(-limit.x, Math.min(limit.x, pan.x)) : 0
  const y = Number.isFinite(pan.y) ? Math.max(-limit.y, Math.min(limit.y, pan.y)) : 0
  return { x, y }
}

/** Масштаб, при котором кадр целиком помещается в окно (contain по обеим осям). */
export function fitScale(video: { width: number; height: number }, viewport: Viewport): number {
  if (video.width <= 0 || video.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  return Math.min(viewport.width / video.width, viewport.height / video.height)
}

/** Масштаб, при котором один исходный пиксель = один CSS-пиксель. */
export function nativeScale(video: { width: number; height: number }, viewport: Viewport): number {
  if (video.width <= 0 || viewport.width <= 0) return 1
  return video.width / viewport.width
}

/**
 * Двойной клик полноэкранного таймлайна: fit ↔ относительный 2× зум в точке
 * клика. Это НЕ «100%» и не скрытый третий режим — fit и native раздельны
 * (раздел 8 ТЗ). Если уже зумирован — сброс в fit; иначе — 2× к точке.
 */
export function toggleFitZoom(
  zoomed: boolean,
  prev: ZoomView,
  point: { x: number; y: number },
  frame: { width: number; height: number },
): ZoomView {
  if (zoomed) return { ...IDENTITY }
  return zoomAtPoint(prev, 2, point, frame)
}

/**
 * Стабильный ключ дедупликации захвата: ровно один на (исходник, время).
 * Время — либо настоящий decoded PTS (если декодер его даёт), либо каноническая
 * строка изначально запрошенного времени ПОСЛЕ зажима.
 *
 * ⚠️ Без epsilon-окна и без округления до fps: соседние времена, различающиеся
 * меньше любого эпсилона, обязаны остаться разными ключами. Совпадает — только
 * реально одинаковый PTS или точный одинаковый запрос.
 */
export function canonicalCaptureKey(
  source: { source: string; assetId?: string; checksum?: string; revision?: number },
  decodedPtsOrExactRequestedTime: number | undefined,
  exactRequestedTime?: number,
): string {
  const stableAsset = source.assetId ?? source.checksum ?? String(source.revision ?? '')
  const time =
    decodedPtsOrExactRequestedTime !== undefined && Number.isFinite(decodedPtsOrExactRequestedTime)
      ? decodedPtsOrExactRequestedTime
      : exactRequestedTime
  return `${source.source}${stableAsset ? `|${stableAsset}` : ''}|${time}`
}

/**
 * Заморозить запрос захвата в неизменяемый снимок. `requestedTime` обязан НЕ
 * читаться из mutable currentTime после async seek (раздел 10 ТЗ): снимок
 * иммутабелен и несёт стабильный dedup-ключ.
 */
export interface FrozenCaptureRequest {
  requestId: string
  source: string
  assetId?: string
  assetRevision?: number
  assetChecksum?: string
  requestedTime: number
  dedupKey: string
}

let requestCounter = 0

export function freezeCaptureRequest(
  sourceSrcIdentity: { source: string; assetId?: string; assetRevision?: number; assetChecksum?: string },
  requestedTime: number,
): FrozenCaptureRequest {
  requestCounter += 1
  return {
    requestId: `cap-${requestCounter}`,
    source: sourceSrcIdentity.source,
    assetId: sourceSrcIdentity.assetId,
    assetRevision: sourceSrcIdentity.assetRevision,
    assetChecksum: sourceSrcIdentity.assetChecksum,
    requestedTime,
    dedupKey: canonicalCaptureKey({
      source: sourceSrcIdentity.source,
      assetId: sourceSrcIdentity.assetId,
      checksum: sourceSrcIdentity.assetChecksum,
      revision: sourceSrcIdentity.assetRevision,
    }, undefined, requestedTime),
  }
}

/**
 * Перевод нажатия указателя в доли ИСХОДНОГО кадра для кропа, при зум/пан/
 * contain. Возвращает доли кадра (0..1 зависимо от выхода за край), чтобы
 * кадрирование считалось от исходных размеров, а не от CSS-окна (раздел 8).
 */
export function mapCropPointerToNormalized(
  rect: { width: number; height: number },
  transform: ZoomView,
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const cx = viewport.width / 2
  const cy = viewport.height / 2
  const fitX = cx + (pointer.x - cx - transform.x) / transform.scale
  const fitY = cy + (pointer.y - cy - transform.y) / transform.scale
  return {
    x: rect.width > 0 && Number.isFinite(fitX) ? fitX / rect.width : 0,
    y: rect.height > 0 && Number.isFinite(fitY) ? fitY / rect.height : 0,
  }
}