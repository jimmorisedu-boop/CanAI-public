// Берём именно WASM-сборку, без WebGPU: она вдвое легче (13 МБ против 25) и
// одинаково работает на любой машине покупателя.
import * as ort from 'onnxruntime-web/wasm'
import {
  cosineSimilarity,
  decodeFaces,
  DETECTOR_SIZE,
  FACE_TEMPLATE,
  invertTransform,
  similarityTransform,
  type DetectedFace,
} from './faceMath'

// Сравнение лиц считается В БРАУЗЕРЕ: движок WASM весит 13 МБ и едет в
// комплекте, а модели на 38 МБ качает тот, кому функция нужна (кнопка в
// настройках, файлы отдаёт сервер из runtime/face-models).
//
// Здесь только обвязка вокруг моделей: картинка → пиксели → лицо → вектор.
// Вся математика живёт в faceMath.ts и проверяется тестами без браузера.

// Движок ищет .wasm рядом с собой; мы кладём его в public/ort, поэтому путь
// задаём явно — иначе он полезет на CDN, а приложение обязано работать офлайн.
ort.env.wasm.wasmPaths = '/ort/'
// Потоки браузер даёт только страницам с особыми заголовками (COOP/COEP).
// Их у нас нет и заводить ради этого нельзя: они ломают загрузку сторонних
// картинок. Один поток на пару лиц — доли секунды.
ort.env.wasm.numThreads = 1

const DETECTOR_FILE = 'face_detection_yunet_2023mar.onnx'
const EMBEDDER_FILE = 'face_recognition_sface_2021dec.onnx'
const modelUrl = (name: string) => `/api/face-models/file/${name}`

export class FaceModelsMissingError extends Error {
  constructor() {
    super('Face-comparison models are not downloaded')
    this.name = 'FaceModelsMissingError'
  }
}

let sessions: Promise<{ detector: ort.InferenceSession; embedder: ort.InferenceSession }> | null = null

async function loadSessions() {
  sessions ??= (async () => {
    const [detector, embedder] = await Promise.all([
      ort.InferenceSession.create(modelUrl(DETECTOR_FILE)),
      ort.InferenceSession.create(modelUrl(EMBEDDER_FILE)),
    ])
    return { detector, embedder }
  })().catch((error) => {
    // Неудачную загрузку не запоминаем: скачает модели — попробует снова.
    sessions = null
    throw error instanceof Error ? error : new FaceModelsMissingError()
  })
  return sessions
}

/** Забыть загруженные модели — например, после докачки или смены версии. */
export function resetFaceSessions(): void {
  sessions = null
}

/** Порядок каналов — НЕ косметика, и у двух моделей он РАЗНЫЙ.
 *
 *  Детектор (YuNet) ждёт BGR: он из OpenCV Zoo, а OpenCV работает в BGR, и
 *  эталонный пайплайн пользователя (InsightFace buffalo_l) тоже целиком BGR.
 *  Замер 22.08.2026 на обложке с тремя лицами: при RGB третье лицо получало
 *  0.24 и не проходило порог вовсе, при BGR — 0.82. Остальные лица тоже
 *  поднялись (0.88 → 0.91, 0.70 → 0.84). То есть RGB не «ломал» детектор
 *  заметно, а тихо срезал ему чутьё на трудных лицах — и увидеть это можно
 *  было только на групповом кадре.
 *
 *  Распознаватель (SFace) ждёт RGB — это отдельный замер 19.08.2026 на
 *  датасетах пользователя: при BGR группы «свой» и «чужой» ПЕРЕКРЫВАЛИСЬ
 *  (зазор −0.0149), при RGB разошлись (+0.0809). */
type ChannelOrder = 'rgb' | 'bgr'

function toTensor(pixels: Uint8ClampedArray, size: number, order: ChannelOrder): ort.Tensor {
  const plane = size * size
  const data = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    data[i] = pixels[i * 4 + (order === 'bgr' ? 2 : 0)]
    data[plane + i] = pixels[i * 4 + 1]
    data[2 * plane + i] = pixels[i * 4 + (order === 'bgr' ? 0 : 2)]
  }
  return new ort.Tensor('float32', data, [1, 3, size, size])
}

function canvasOf(size: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('The browser did not provide a canvas to analyze the image')
  return { canvas, ctx }
}

async function bitmapOf(src: string): Promise<ImageBitmap> {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`Image failed to load (${response.status})`)
  return createImageBitmap(await response.blob())
}

/** Найденные лица картинки, крупное первым. */
export async function detectFaces(src: string): Promise<DetectedFace[]> {
  const { detector } = await loadSessions()
  const bitmap = await bitmapOf(src)
  try {
    const scale = Math.min(DETECTOR_SIZE / bitmap.width, DETECTOR_SIZE / bitmap.height)
    const { ctx } = canvasOf(DETECTOR_SIZE)
    // Вписываем без искажения пропорций: растянутое лицо сдвигает точки.
    ctx.drawImage(bitmap, 0, 0, bitmap.width * scale, bitmap.height * scale)
    const pixels = ctx.getImageData(0, 0, DETECTOR_SIZE, DETECTOR_SIZE).data
    const output = await detector.run({ input: toTensor(pixels, DETECTOR_SIZE, 'bgr') })
    const heads: Record<string, ArrayLike<number>> = {}
    for (const name of detector.outputNames) heads[name] = output[name].data as Float32Array
    return decodeFaces(heads, scale)
  } finally {
    bitmap.close()
  }
}

export interface FaceVector {
  vector: Float32Array
  /** Тот же кадр зеркально: профиль и боковой свет так узнаются заметно
   *  лучше, а стоит это одного лишнего прогона (замер: худший «свой»
   *  0.5819 → 0.5968, лучший «чужой» не сдвинулся). */
  mirrored: Float32Array
  face: DetectedFace
  /** Сколько лиц всего нашлось — на групповом кадре это важно сказать. */
  faces: number
}

const cache = new Map<string, Promise<FaceVector | null>>()

/** Вектор лица картинки или null, если лица нет.
 *
 *  Вектор не меняется, пока не меняется файл, поэтому помним его по ссылке:
 *  повторное сравнение той же пары мгновенно. */
export function embedFace(src: string, faceIndex = 0): Promise<FaceVector | null> {
  const key = `${src}#${faceIndex}`
  const known = cache.get(key)
  if (known) return known
  const pending = compute(src, faceIndex).catch((error) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, pending)
  return pending
}

async function run(session: ort.InferenceSession, pixels: Uint8ClampedArray): Promise<Float32Array> {
  const output = await session.run({ data: toTensor(pixels, 112, 'rgb') })
  const raw = output[session.outputNames[0]].data as Float32Array
  let norm = 0
  for (const value of raw) norm += value * value
  norm = Math.sqrt(norm) || 1
  const vector = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) vector[i] = raw[i] / norm
  return vector
}

async function compute(src: string, faceIndex: number): Promise<FaceVector | null> {
  const faces = await detectFaces(src)
  const face = faces[faceIndex]
  if (!face) return null
  const { embedder } = await loadSessions()
  const bitmap = await bitmapOf(src)
  try {
    const { canvas, ctx } = canvasOf(112)
    const t = similarityTransform(face.points, FACE_TEMPLATE)
    // Холст сам разложит исходные пиксели по канону: поворот, масштаб, сдвиг.
    ctx.setTransform(t.a, t.b, -t.b, t.a, t.tx, t.ty)
    ctx.drawImage(bitmap, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
        const direct = ctx.getImageData(0, 0, 112, 112).data
    // Зеркалим сам выровненный кадр, а не исходник: детекцию повторять незачем.
    ctx.setTransform(-1, 0, 0, 1, 112, 0)
    ctx.drawImage(canvas, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const flipped = ctx.getImageData(0, 0, 112, 112).data
    const [vector, mirrored] = await Promise.all([
      run(embedder, direct),
      run(embedder, flipped),
    ])
    return { vector, mirrored, face, faces: faces.length }
  } finally {
    bitmap.close()
  }
}

export type FaceComparison =
  | { kind: 'ready'; similarity: number; facesA: number; facesB: number }
  | { kind: 'no-face'; where: 'a' | 'b' | 'both' }

/** Сходство двух картинок. Нет лица — так и говорим, а не выдумываем число. */
export async function compareFaces(
  a: string,
  b: string,
  faceIndexA = 0,
  faceIndexB = 0,
): Promise<FaceComparison> {
  const [left, right] = await Promise.all([embedFace(a, faceIndexA), embedFace(b, faceIndexB)])
  if (!left && !right) return { kind: 'no-face', where: 'both' }
  if (!left) return { kind: 'no-face', where: 'a' }
  if (!right) return { kind: 'no-face', where: 'b' }
  return {
    kind: 'ready',
    // Лучшее из трёх: прямо, и каждый кадр против зеркала другого.
    similarity: Math.max(
      cosineSimilarity(left.vector, right.vector),
      cosineSimilarity(left.mirrored, right.vector),
      cosineSimilarity(left.vector, right.mirrored),
    ),
    facesA: left.faces,
    facesB: right.faces,
  }
}

export { invertTransform }
