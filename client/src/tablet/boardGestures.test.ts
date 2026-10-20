// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import * as gestureModule from './boardGestures'
import {
  DOUBLE_TAP_MAX_DISTANCE_PX,
  DOUBLE_TAP_MAX_MS,
  fitCamera,
  hitTest,
  isDoubleTap,
  isViewerItem,
  movedFar,
  panBy,
  pinchGeometry,
  pinchTo,
  screenDeltaToWorld,
  screenToWorld,
  snapDragToContent,
  visibleOnScreen,
  worldToScreen,
  zoomAt,
} from './boardGestures'

function shouldReleasePromptFocus(active: { tagName: string; inTabletPrompt: boolean } | null): boolean | undefined {
  return (gestureModule as typeof gestureModule & {
    shouldReleasePromptFocus?: (value: typeof active) => boolean
  }).shouldReleasePromptFocus?.(active)
}

const ITEMS = [
  { id: 'a', x: 0, y: 0, w: 100, h: 100 },
  { id: 'b', x: 50, y: 50, w: 100, h: 100 },
  { id: 'far', x: 5000, y: 5000, w: 100, h: 100 },
]

test('касание канваса снимает фокус только с поля планшетного промпта', () => {
  assert.equal(shouldReleasePromptFocus({ tagName: 'TEXTAREA', inTabletPrompt: true }), true)
  assert.equal(shouldReleasePromptFocus({ tagName: 'INPUT', inTabletPrompt: true }), true)
  assert.equal(shouldReleasePromptFocus({ tagName: 'TEXTAREA', inTabletPrompt: false }), false)
  assert.equal(shouldReleasePromptFocus(null), false)
})

test('масштаб к точке оставляет её на месте', () => {
  // Ради этого зум и делается «к точке»: место доски под пальцами не должно
  // уезжать, иначе щипок ощущается рывком.
  const camera = { x: 20, y: 30, scale: 1 }
  const pointer = { x: 200, y: 150 }
  const before = screenToWorld(camera, pointer)
  const after = zoomAt(camera, pointer, 2.5)
  const back = worldToScreen(after, before)
  assert.ok(Math.abs(back.x - pointer.x) < 0.001)
  assert.ok(Math.abs(back.y - pointer.y) < 0.001)
})

test('масштаб держится в разумных пределах', () => {
  const camera = { x: 0, y: 0, scale: 1 }
  assert.equal(zoomAt(camera, { x: 0, y: 0 }, 500).scale, 8)
  assert.equal(zoomAt(camera, { x: 0, y: 0 }, 0.0001).scale, 0.05)
})

test('щипок двумя пальцами одновременно масштабирует и везёт', () => {
  const start = { camera: { x: 0, y: 0, scale: 1 }, center: { x: 100, y: 100 }, distance: 100 }
  // Пальцы развели вдвое И сдвинули центр вправо на 50.
  const next = pinchTo(start, { center: { x: 150, y: 100 }, distance: 200 })
  assert.equal(next.scale, 2)
  // Точка доски (100,100) должна оказаться под новым центром жеста.
  const shown = worldToScreen(next, { x: 100, y: 100 })
  assert.ok(Math.abs(shown.x - 150) < 0.001)
  assert.ok(Math.abs(shown.y - 100) < 0.001)
})

test('два пальца в одной точке не ломают масштаб', () => {
  // Расстояние ноль дало бы деление на ноль — на стекле это бывает.
  const geometry = pinchGeometry([{ x: 10, y: 10 }, { x: 10, y: 10 }])
  assert.equal(geometry?.distance, 1)
})

test('одному пальцу щипок не считается', () => {
  assert.equal(pinchGeometry([{ x: 1, y: 1 }]), null)
  assert.equal(pinchGeometry([]), null)
})

test('порог движения отличает касание от перетаскивания', () => {
  // Палец на стекле никогда не стоит неподвижно; без порога любое касание
  // оказывалось бы перетаскиванием, и выделить объект стало бы невозможно.
  assert.equal(movedFar({ x: 0, y: 0 }, { x: 3, y: 3 }), false)
  assert.equal(movedFar({ x: 0, y: 0 }, { x: 9, y: 0 }), true)
})

test('двойной tap распознаётся только для того же медиа объекта в коротком окне', () => {
  const first = { itemId: 'photo', at: { x: 100, y: 100 }, timestamp: 1_000 }
  assert.equal(isDoubleTap(first, { itemId: 'photo', at: { x: 100 + DOUBLE_TAP_MAX_DISTANCE_PX, y: 100 }, timestamp: 1_000 + DOUBLE_TAP_MAX_MS }), true)
  assert.equal(isDoubleTap(first, { itemId: 'other', at: { x: 100, y: 100 }, timestamp: 1_010 }), false)
  assert.equal(isDoubleTap(first, { itemId: 'photo', at: { x: 100, y: 100 }, timestamp: 1_000 + DOUBLE_TAP_MAX_MS + 1 }), false)
  assert.equal(isDoubleTap(first, { itemId: 'photo', at: { x: 100 + DOUBLE_TAP_MAX_DISTANCE_PX + 1, y: 100 }, timestamp: 1_010 }), false)
})

test('крупный просмотр доступен только готовым изображениям и видео', () => {
  assert.equal(isViewerItem({ id: 'photo', kind: 'image', src: '/media/photo.png', x: 0, y: 0, w: 100, h: 100 }), true)
  assert.equal(isViewerItem({ id: 'clip', kind: 'video', src: '/media/clip.mp4', x: 0, y: 0, w: 100, h: 100 }), true)
  assert.equal(isViewerItem({ id: 'text', kind: 'text', text: 'hello', x: 0, y: 0, w: 100, h: 100 }), false)
  assert.equal(isViewerItem({ id: 'pending', kind: 'image', status: 'loading', label: 'model', startedAt: 1, x: 0, y: 0, w: 100, h: 100 }), false)
})

test('под пальцем оказывается верхний объект', () => {
  // Последний в списке нарисован сверху — попадать надо в него.
  assert.equal(hitTest(ITEMS, { x: 75, y: 75 }), 'b')
  assert.equal(hitTest(ITEMS, { x: 10, y: 10 }), 'a')
  assert.equal(hitTest(ITEMS, { x: 400, y: 400 }), null)
})

test('за краем экрана ничего не рисуется', () => {
  // Планшету нельзя держать в памяти всю доску: вкладка Safari вылетает
  // раньше, чем кончается терпение.
  const visible = visibleOnScreen(ITEMS, { x: 0, y: 0, scale: 1 }, { w: 400, h: 400 })
  assert.deepEqual(visible.map((item) => item.id), ['a', 'b'])
})

test('выделенное рисуется, даже если уехало за край', () => {
  const visible = visibleOnScreen(ITEMS, { x: 0, y: 0, scale: 1 }, { w: 400, h: 400 }, new Set(['far']))
  assert.deepEqual(visible.map((item) => item.id), ['a', 'b', 'far'])
})

test('«показать всё» вмещает доску в экран', () => {
  const camera = fitCamera([{ id: 'a', x: 0, y: 0, w: 1000, h: 500 }], { w: 500, h: 500 }, 50)
  const topLeft = worldToScreen(camera, { x: 0, y: 0 })
  const bottomRight = worldToScreen(camera, { x: 1000, y: 500 })
  assert.ok(topLeft.x >= 49 && bottomRight.x <= 451)
  assert.ok(topLeft.y >= 0 && bottomRight.y <= 500)
})

test('пустая доска не ломает «показать всё»', () => {
  const camera = fitCamera([], { w: 800, h: 600 })
  assert.deepEqual(camera, { x: 400, y: 300, scale: 1 })
})

test('панорама двигает камеру ровно на смещение пальца', () => {
  assert.deepEqual(panBy({ x: 10, y: 20, scale: 2 }, 5, -5), { x: 15, y: 15, scale: 2 })
})

test('перетаскивание объекта следует за пальцем при любом масштабе', () => {
  // Карточка живёт внутри уже масштабированного world-слоя. Поэтому экранное
  // движение надо один раз перевести в мировое — иначе при 50% она отстаёт от
  // пальца вдвое, а после отпускания скачком догоняет его.
  assert.deepEqual(screenDeltaToWorld({ x: 120, y: -40 }, 0.5), { x: 240, y: -80 })
  assert.deepEqual(screenDeltaToWorld({ x: 120, y: -40 }, 2), { x: 60, y: -20 })
})

test('перетаскиваемый объект магнитится к краю соседнего контента', () => {
  const result = snapDragToContent(
    [
      { id: 'moving', x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      { id: 'target', x: 206, y: 40, w: 80, h: 80, rotation: 0 },
    ],
    ['moving'],
    'moving',
    { x: 102, y: 0 },
    1,
  )

  assert.deepEqual(result.delta, { x: 106, y: 0 })
  assert.ok(result.guides.some((guide) => guide[0] === 206 && guide[2] === 206))
})

test('порог магнита остаётся экранным при изменении масштаба', () => {
  const items = [
    { id: 'moving', x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    { id: 'target', x: 206, y: 300, w: 80, h: 80, rotation: 0 },
  ]

  const zoomedIn = snapDragToContent(items, ['moving'], 'moving', { x: 101, y: 0 }, 2)
  const zoomedOut = snapDragToContent(items, ['moving'], 'moving', { x: 101, y: 0 }, 0.5)

  assert.equal(zoomedIn.delta.x, 101, '5 мировых пикселей — уже дальше 8 экранных при масштабе 2×')
  assert.equal(zoomedOut.delta.x, 106, 'те же 5 мировых пикселей должны прилипнуть при масштабе 0.5×')
})

test('выделенная группа магнитится целиком и не липнет к самой себе', () => {
  const items = [
    { id: 'first', x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    { id: 'grabbed', x: 130, y: 20, w: 50, h: 50, rotation: 0 },
    { id: 'target', x: 300, y: 200, w: 100, h: 100, rotation: 0 },
  ]
  const result = snapDragToContent(items, ['first', 'grabbed'], 'grabbed', { x: 114, y: 0 }, 1)
  const withoutTarget = snapDragToContent(items.slice(0, 2), ['first', 'grabbed'], 'grabbed', { x: 114, y: 0 }, 1)

  assert.deepEqual(result.delta, { x: 120, y: 0 })
  assert.ok(result.guides.some((guide) => guide[0] === 300 && guide[2] === 300))
  assert.deepEqual(withoutTarget, { delta: { x: 114, y: 0 }, guides: [] })
})

test('нулевой замер окна не прячет доску', () => {
  // Размер приходит от ResizeObserver и бывает нулевым при первой раскладке,
  // повороте и в раздельном экране. Отсечь по нему — значит показать человеку
  // пустой холст вместо его материала (поймано живым прогоном).
  const visible = visibleOnScreen(ITEMS, { x: 0, y: 0, scale: 1 }, { w: 0, h: 0 })
  assert.equal(visible.length, ITEMS.length)
})
