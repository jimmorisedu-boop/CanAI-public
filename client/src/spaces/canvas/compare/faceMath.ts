// Чистая математика сравнения лиц: без DOM, без сети, без onnxruntime —
// чтобы её можно было проверить тестами, а не глазами на живой странице.
//
// Цепочка целиком: YuNet находит лицо и пять точек → кадр выравнивается по
// канону 112×112 → SFace превращает его в вектор → косинус двух векторов и
// есть сходство. Здесь живут все шаги, кроме собственно вызова моделей.

/** Канонические пять точек (глаза, нос, углы рта) для кадра 112×112.
 *  Такое же выравнивание ждут ArcFace и SFace — без него сходство падает. */
export const FACE_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]

export const DETECTOR_SIZE = 640
export const DETECTOR_STRIDES = [8, 16, 32] as const

export interface DetectedFace {
  score: number
  x: number
  y: number
  w: number
  h: number
  points: Array<[number, number]>
}

/** Подобие: поворот, масштаб и сдвиг — без сдвига углов и растяжения по одной
 *  оси. Замкнутая формула метода наименьших квадратов; матрица вида
 *  [[a, −b], [b, a]] сама по себе есть поворот с масштабом. */
export function similarityTransform(
  from: ReadonlyArray<readonly [number, number]>,
  to: ReadonlyArray<readonly [number, number]>,
): { a: number; b: number; tx: number; ty: number } {
  const n = Math.min(from.length, to.length)
  if (n < 2) throw new Error('Similarity needs at least two points')
  let fx = 0, fy = 0, tx = 0, ty = 0
  for (let i = 0; i < n; i++) {
    fx += from[i][0]; fy += from[i][1]
    tx += to[i][0]; ty += to[i][1]
  }
  fx /= n; fy /= n; tx /= n; ty /= n
  let norm = 0, dot = 0, cross = 0
  for (let i = 0; i < n; i++) {
    const px = from[i][0] - fx, py = from[i][1] - fy
    const qx = to[i][0] - tx, qy = to[i][1] - ty
    norm += px * px + py * py
    dot += px * qx + py * qy
    cross += px * qy - py * qx
  }
  if (norm === 0) throw new Error('Points coincide; similarity is undefined')
  const a = dot / norm
  const b = cross / norm
  return { a, b, tx: tx - (a * fx - b * fy), ty: ty - (b * fx + a * fy) }
}

export function invertTransform(
  t: { a: number; b: number; tx: number; ty: number },
): { a: number; b: number; tx: number; ty: number } {
  const det = t.a * t.a + t.b * t.b
  if (det === 0) throw new Error('Degenerate transform')
  const a = t.a / det
  const b = -t.b / det
  return { a, b, tx: -(a * t.tx - b * t.ty), ty: -(b * t.tx + a * t.ty) }
}

export function applyTransform(
  t: { a: number; b: number; tx: number; ty: number },
  x: number,
  y: number,
): [number, number] {
  return [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty]
}

/** Разбор сырых голов YuNet. Модель отдаёт по три набора на каждый шаг сетки
 *  (8, 16, 32): уверенность, «тут вообще объект», рамку и пять точек. */
export function decodeFaces(
  heads: Record<string, ArrayLike<number>>,
  scale: number,
  minScore = 0.6,
): DetectedFace[] {
  const faces: DetectedFace[] = []
  for (const stride of DETECTOR_STRIDES) {
    const cls = heads[`cls_${stride}`]
    const obj = heads[`obj_${stride}`]
    const box = heads[`bbox_${stride}`]
    const kps = heads[`kps_${stride}`]
    if (!cls || !obj || !box || !kps) continue
    const cols = Math.floor(DETECTOR_SIZE / stride)
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.max(0, cls[i]) * Math.max(0, obj[i]))
      if (score < minScore) continue
      const cx = (i % cols) * stride
      const cy = Math.floor(i / cols) * stride
      const points: Array<[number, number]> = []
      for (let p = 0; p < 5; p++) {
        points.push([
          (cx + kps[i * 10 + p * 2] * stride) / scale,
          (cy + kps[i * 10 + p * 2 + 1] * stride) / scale,
        ])
      }
      // ⚠️ Модель предсказывает ЦЕНТР рамки, а не её левый верхний угол.
      // Принятый за угол центр сдвигал рамку вниз-вправо ровно на половину
      // её размера: на портрете рамка [690, 385, 324, 441] оказывалась под
      // глазом, который детектор ставил в (613, 335) — то есть ВЫШЕ и ЛЕВЕЕ
      // собственного «угла» рамки (замер 22.08.2026). На сходство это не
      // влияло — выравнивание идёт по пяти точкам, а не по рамке, — поэтому
      // ошибка жила незаметно до первого показа рамок человеку.
      const w = (Math.exp(box[i * 4 + 2]) * stride) / scale
      const h = (Math.exp(box[i * 4 + 3]) * stride) / scale
      faces.push({
        score,
        x: (cx + box[i * 4] * stride) / scale - w / 2,
        y: (cy + box[i * 4 + 1] * stride) / scale - h / 2,
        w,
        h,
        points,
      })
    }
  }
  // ⚠️ Сначала СЛИВАЕМ дубли. Модель отдаёт по рамке с каждой подходящей
  // клетки трёх сеток, и одно лицо даёт их до десятка (замер на портрете:
  // 10 рамок вокруг одного лица). Без слияния счётчик врал бы «в кадре
  // несколько лиц» почти всегда, а для выравнивания бралась бы не самая
  // уверенная рамка, а просто самая большая.
  const merged = suppressOverlaps(faces)
  // Самое крупное лицо первым: ради него кадр и снимали. Групповые кадры —
  // случай, где человек выбирает сам, поэтому порядок должен быть понятным.
  merged.sort((a, b) => b.w * b.h - a.w * a.h)
  return merged
}

function overlap(a: DetectedFace, b: DetectedFace): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const both = x * y
  const union = a.w * a.h + b.w * b.h - both
  return union > 0 ? both / union : 0
}

/** Из группы рамок вокруг одного лица оставляем самую уверенную. */
export function suppressOverlaps(faces: DetectedFace[], maxOverlap = 0.35): DetectedFace[] {
  const kept: DetectedFace[] = []
  for (const face of [...faces].sort((a, b) => b.score - a.score)) {
    if (kept.some((other) => overlap(face, other) > maxOverlap)) continue
    kept.push(face)
  }
  return kept
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error('Vectors have different lengths')
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** Порог по умолчанию.
 *
 * ⚠️ Число из чужого инструмента сюда не переносится: у каждой модели своя
 * шкала. В ComfyUI-ноде пользователя стоит 0.65, но там другая модель —
 * поставь мы 0.65, половина настоящих совпадений уехала бы в «не тот человек».
 *
 * Замер 19.08.2026 на трёх датасетах пользователя, где ракурсы, свет и мимика
 * гуляют вовсю. Сравнение с эталоном (так и работает просмотрщик): худший
 * «свой» 0.6308, лучший «чужой» 0.2035 — промахов и ложных срабатываний нет.
 * Худший случай вообще, когда обе картинки сняты неудачно: свои от 0.3984,
 * чужие до 0.3175. Порог держим ближе к нижней границе: пропустить настоящее
 * сходство хуже, чем показать спорное число — его человек увидит сам. */
export const DEFAULT_FACE_THRESHOLD = 0.36

export type FaceVerdict = 'same' | 'different'

export function faceVerdict(similarity: number, threshold: number): FaceVerdict {
  return similarity >= threshold ? 'same' : 'different'
}

/** В интерфейсе человек сравнивает проценты, а не коэффициенты модели. */
export function formatSimilarity(similarity: number): string {
  const percent = Math.round((similarity + Number.EPSILON) * 1000) / 10
  return `${percent.toFixed(1).replace('.', ',')}%`
}

/** Рамка лица в долях кадра (0..1) — для отрисовки поверх картинки.
 *
 * Детектор отдаёт рамки в ПИКСЕЛЯХ исходника, а на экране картинка вписана в
 * произвольный бокс. Доли переживают любой масштаб, поэтому переводим один раз
 * и здесь: считать это в компоненте — верный способ разъехаться с картинкой.
 * Рамка подрезается по краям: у лица с краю кадра детектор спокойно отдаёт
 * координаты за границей, и рамка вылезала бы за картинку. */
export function faceBoxFraction(
  face: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, w: 0, h: 0 }
  const left = Math.min(Math.max(face.x / width, 0), 1)
  const top = Math.min(Math.max(face.y / height, 0), 1)
  return {
    x: left,
    y: top,
    w: Math.min(Math.max(face.w / width, 0), 1 - left),
    h: Math.min(Math.max(face.h / height, 0), 1 - top),
  }
}
