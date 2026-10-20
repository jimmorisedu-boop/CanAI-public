// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  applyTransform,
  cosineSimilarity,
  decodeFaces,
  DEFAULT_FACE_THRESHOLD,
  faceVerdict,
  FACE_TEMPLATE,
  formatSimilarity,
  invertTransform,
  similarityTransform,
  suppressOverlaps,
  faceBoxFraction,
} from './faceMath'
import { FaceSimilarityChip } from './FaceSimilarityChip'

// Выравнивание — половина точности сравнения: перекошенный кадр даёт другой
// вектор у того же человека. Поэтому проверяем математику отдельно от моделей.

const round = (v: number) => Math.round(v * 1e6) / 1e6

test('подобие точно возвращает повёрнутый и сдвинутый набор точек', () => {
  // Берём канон, крутим на 30°, увеличиваем и сдвигаем — преобразование
  // обязано вернуть его ровно назад.
  const angle = Math.PI / 6
  const scale = 1.7
  const moved = FACE_TEMPLATE.map(([x, y]) => [
    scale * (x * Math.cos(angle) - y * Math.sin(angle)) + 40,
    scale * (x * Math.sin(angle) + y * Math.cos(angle)) - 12,
  ] as [number, number])

  const t = similarityTransform(moved, FACE_TEMPLATE)
  for (let i = 0; i < FACE_TEMPLATE.length; i++) {
    const [x, y] = applyTransform(t, moved[i][0], moved[i][1])
    assert.equal(round(x), round(FACE_TEMPLATE[i][0]))
    assert.equal(round(y), round(FACE_TEMPLATE[i][1]))
  }
})

test('обратное преобразование возвращает точку на место', () => {
  // Кадр 112×112 собирается обратным ходом: для каждого пикселя результата
  // берём исходный. Ошибка здесь — молча съехавшее лицо.
  const t = { a: 0.8, b: 0.35, tx: 17, ty: -9 }
  const back = invertTransform(t)
  const [x, y] = applyTransform(t, 12, 34)
  const [rx, ry] = applyTransform(back, x, y)
  assert.equal(round(rx), 12)
  assert.equal(round(ry), 34)
})

test('degenerate cases explain themselves instead of producing garbage', () => {
  assert.throws(() => similarityTransform([[1, 1]], [[2, 2]]), /at least two points/)
  assert.throws(() => similarityTransform([[5, 5], [5, 5]], [[1, 2], [3, 4]]), /Points coincide/)
  assert.throws(() => invertTransform({ a: 0, b: 0, tx: 1, ty: 1 }), /Degenerate/)
})

test('косинус: сам с собой единица, противоположные минус единица', () => {
  const v = [0.2, -0.5, 0.83]
  assert.equal(round(cosineSimilarity(v, v)), 1)
  assert.equal(round(cosineSimilarity(v, v.map((x) => -x))), -1)
  assert.equal(round(cosineSimilarity([1, 0], [0, 1])), 0)
  // Нулевой вектор — не «единица сходства»: сравнивать нечего.
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /different lengths/)
})

function heads(faces: Array<{ index: number; stride: 8 | 16 | 32; score: number; size: number }>) {
  const out: Record<string, number[]> = {}
  for (const stride of [8, 16, 32]) {
    const cells = (640 / stride) ** 2
    out[`cls_${stride}`] = new Array(cells).fill(0)
    out[`obj_${stride}`] = new Array(cells).fill(0)
    out[`bbox_${stride}`] = new Array(cells * 4).fill(0)
    out[`kps_${stride}`] = new Array(cells * 10).fill(0)
  }
  for (const face of faces) {
    out[`cls_${face.stride}`][face.index] = face.score
    out[`obj_${face.stride}`][face.index] = face.score
    out[`bbox_${face.stride}`][face.index * 4 + 2] = Math.log(face.size / face.stride)
    out[`bbox_${face.stride}`][face.index * 4 + 3] = Math.log(face.size / face.stride)
  }
  return out
}

test('самое крупное лицо идёт первым', () => {
  // На групповом кадре меряем то, ради которого кадр и снимали.
  const found = decodeFaces(heads([
    { index: 10, stride: 8, score: 0.9, size: 40 },
    { index: 4, stride: 16, score: 0.9, size: 160 },
  ]), 1)
  assert.equal(found.length, 2)
  assert.ok(found[0].w > found[1].w, 'первым обязано идти крупное')
})

test('рамка стоит ВОКРУГ точки лица, а не начинается в ней', () => {
  // ⚠️ Сторож против ошибки, которая пряталась месяц: модель предсказывает
  // ЦЕНТР рамки, а код принимал его за левый верхний угол. Сходство при этом
  // считалось верно (выравнивание идёт по пяти точкам), поэтому увидеть
  // ошибку можно было, только показав рамки человеку — что и случилось:
  // рамки сели на рот и подбородок вместо лиц.
  //
  // В заглушке смещения нулевые, значит центр рамки — сама клетка сетки, и
  // туда же попадают все пять точек. Требование простое и переживёт любую
  // перепись разбора: точки лица обязаны лежать ВНУТРИ его рамки.
  const stride = 8
  const index = 10
  const size = 40
  const [face] = decodeFaces(heads([{ index, stride, score: 0.9, size }]), 1)
  const cols = 640 / stride
  const cellX = (index % cols) * stride
  const cellY = Math.floor(index / cols) * stride
  assert.equal(face.x, cellX - size / 2)
  assert.equal(face.y, cellY - size / 2)
  for (const [px, py] of face.points) {
    assert.ok(px >= face.x && px <= face.x + face.w, 'точка вышла за рамку по горизонтали')
    assert.ok(py >= face.y && py <= face.y + face.h, 'точка вышла за рамку по вертикали')
  }
})

test('слабые срабатывания отсекаются порогом', () => {
  const weak = heads([{ index: 3, stride: 8, score: 0.2, size: 50 }])
  assert.equal(decodeFaces(weak, 1).length, 0)
  assert.equal(decodeFaces(weak, 1, 0.1).length, 1)
})

test('неполный ответ модели не роняет разбор', () => {
  // Лучше «лиц не найдено», чем исключение посреди сравнения.
  assert.deepEqual(decodeFaces({ cls_8: [1, 1] }, 1), [])
})

test('вердикт берётся от порога, а не от вкуса', () => {
  assert.equal(faceVerdict(0.42, 0.36), 'same')
  assert.equal(faceVerdict(0.36, 0.36), 'same')
  assert.equal(faceVerdict(0.3599, 0.36), 'different')
})

test('порог по умолчанию лежит между замеренными группами', () => {
  // Замер на датасетах пользователя, худший случай (обе картинки неудачные):
  // свои от 0.3984, чужие до 0.3175. При сравнении с эталоном запас куда
  // больше: 0.6308 против 0.2035. Чужое число (0.65 из ComfyUI-ноды) сюда не
  // переносится — другая модель и другая шкала.
  assert.ok(DEFAULT_FACE_THRESHOLD > 0.3175, 'иначе чужие пройдут как свои')
  assert.ok(DEFAULT_FACE_THRESHOLD < 0.3984, 'иначе свои будут отвергнуты')
})

test('сходство показывается как понятный процент с десятичной запятой', () => {
  assert.equal(formatSimilarity(0.7412345), '74,1%')
  assert.equal(formatSimilarity(1), '100,0%')
})

test('неоднозначность лица идёт отдельной строкой после результата', () => {
  const html = renderToStaticMarkup(createElement(FaceSimilarityChip, {
    state: {
      kind: 'result',
      value: { kind: 'ready', similarity: 0.3645, facesA: 1, facesB: 3 },
    },
    threshold: 0.36,
    onThreshold: () => {},
    onEnable: () => {},
    onPick: () => {},
  }))

  assert.match(html, /class="face-chip-result"[^>]*>\s*<b[^>]*>36,5%<\/b>\s*<span class="face-chip-verdict">same person<\/span>/)
  assert.match(html, />Threshold 36%<\/button>/)
  assert.match(html, /class="face-chip-context"[^>]*>\s*<span>Multiple faces in the candidate<\/span>/)
  assert.match(html, /class="face-chip-pick"[^>]*>Select face<\/button>/)
  assert.ok(
    html.indexOf('face-chip-context') > html.indexOf('face-chip-result'),
    'пояснение не должно разрывать основной результат',
  )
})

const box = (x: number, y: number, size: number, score: number) => ({
  score, x, y, w: size, h: size, points: [] as Array<[number, number]>,
})

test('рамки вокруг одного лица сливаются в одну, самую уверенную', () => {
  // Модель отдаёт рамку с каждой подходящей клетки трёх сеток: замер на
  // обычном портрете дал 10 рамок вокруг ОДНОГО лица. Без слияния счётчик
  // врал бы «в кадре несколько лиц» почти всегда.
  const kept = suppressOverlaps([
    box(480, 520, 750, 0.65),
    box(500, 540, 740, 0.86),
    box(520, 560, 720, 0.71),
  ])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].score, 0.86)
})

test('настоящие соседние лица остаются оба', () => {
  const kept = suppressOverlaps([box(0, 0, 200, 0.9), box(400, 0, 200, 0.8)])
  assert.equal(kept.length, 2)
})

test('разбор сразу отдаёт слитые рамки', () => {
  // Тот же порядок, что у настоящей модели: сначала слить, потом крупное
  // первым. Две соседние клетки одной сетки — это одно лицо.
  const found = decodeFaces(heads([
    { index: 10, stride: 8, score: 0.9, size: 120 },
    { index: 11, stride: 8, score: 0.7, size: 120 },
  ]), 1)
  assert.equal(found.length, 1, 'соседние клетки описывают одно лицо')
})

test('причина неудачи спрашивается у сервера, а не угадывается по тексту', () => {
  // Жалоба 20.08.2026: у коллеги вместо понятного «включить сравнение лиц»
  // висело «сходство не посчиталось». Причину определяли шаблоном по тексту
  // ошибки движка, а на другой машине он говорит своё.
  const source = readFileSync(new URL('./FaceSimilarityChip.tsx', import.meta.url), 'utf8')
  assert.match(source, /api\.faceModelsState\(\)/)
  assert.doesNotMatch(source, /не скачан\|404\|409/, 'угадывание по тексту не должно вернуться')
  // Три разные причины — три разных совета, и каждый выполним.
  assert.match(source, /kind: 'no-models'/)
  assert.match(source, /kind: 'stale'/)
  assert.match(source, /ort-wasm-simd-threaded\.wasm/)
})

// ⚠️ Рамку рисуем долями кадра: на экране картинка вписана в произвольный бокс,
// а детектор отдаёт пиксели исходника. Считать это в компоненте — верный способ
// разъехаться с лицами (выбор лица включается отдельно, 21.08.2026).
test('рамка лица переводится в доли кадра', () => {
  const box = faceBoxFraction({ x: 100, y: 50, w: 200, h: 100 }, 400, 200)
  assert.deepEqual(box, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
})

test('лицо у края не вылезает за картинку', () => {
  // детектор спокойно отдаёт координаты за границей кадра
  const box = faceBoxFraction({ x: 380, y: 190, w: 100, h: 100 }, 400, 200)
  assert.ok(box.x + box.w <= 1.0001)
  assert.ok(box.y + box.h <= 1.0001)
  const слева = faceBoxFraction({ x: -20, y: -10, w: 100, h: 60 }, 400, 200)
  assert.equal(слева.x, 0)
  assert.equal(слева.y, 0)
})

test('битый размер кадра не роняет отрисовку', () => {
  assert.deepEqual(faceBoxFraction({ x: 1, y: 1, w: 1, h: 1 }, 0, 0), { x: 0, y: 0, w: 0, h: 0 })
  assert.deepEqual(faceBoxFraction({ x: 1, y: 1, w: 1, h: 1 }, Number.NaN, 100), { x: 0, y: 0, w: 0, h: 0 })
})
