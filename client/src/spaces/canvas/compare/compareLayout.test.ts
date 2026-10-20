import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareLayout,
  fitBox,
  layoutHint,
  MAX_PANELS,
  naturalSize,
  overlayFrame,
  visibleSlice,
  wipeClipPath,
  wipeFractionInBox,
  wipePercent,
  wrapCursor,
  zoomedBox,
} from './compareLayout'

test('раскладка следует из типов, а не из выбора пользователя', () => {
  assert.equal(compareLayout(['image', 'image']), 'overlay')
  assert.equal(compareLayout(['image', 'image', 'image']), 'overlay')
  assert.equal(compareLayout(['video', 'video']), 'side-by-side')
  assert.equal(compareLayout(['image', 'video']), 'side-by-side')
  // одно видео среди картинок всё равно уводит в панели: наложение на движении
  // показывает разницу таймкодов, а не разницу моделей
  assert.equal(compareLayout(['image', 'image', 'video']), 'side-by-side')
})

test('hint names the layout before opening it', () => {
  assert.match(layoutHint(['image', 'image']), /compare as overlay/)
  assert.match(layoutHint(['image', 'video']), /compare side by side/)
  assert.match(layoutHint([]), /Choose/)
})

test('кадр вписывается целиком и центрируется', () => {
  const box = fitBox({ width: 1000, height: 500 }, { width: 400, height: 400 })
  assert.equal(box.width, 400)
  assert.equal(box.height, 200)
  assert.equal(box.x, 0)
  assert.equal(box.y, 100)

  const portrait = fitBox({ width: 500, height: 1000 }, { width: 400, height: 400 })
  assert.equal(portrait.width, 200)
  assert.equal(portrait.height, 400)
  assert.equal(portrait.x, 100)
  assert.equal(portrait.y, 0)
})

test('битые размеры не роняют просмотрщик', () => {
  const box = fitBox({ width: 0, height: 0 }, { width: 300, height: 200 })
  assert.deepEqual(box, { x: 0, y: 0, width: 300, height: 200 })
})

test('штора считается от рамки и не вылезает за края', () => {
  const rect = { left: 100, width: 200 }
  assert.equal(wipePercent(200, rect), 50)
  assert.equal(wipePercent(50, rect), 0) // левее рамки
  assert.equal(wipePercent(999, rect), 100) // правее рамки
  assert.equal(wipePercent(150, { left: 0, width: 0 }), 50) // рамка ещё не измерена
})

test('clip-path показывает верхний слой слева от шторы', () => {
  assert.equal(wipeClipPath(0), 'inset(0 100% 0 0)')
  assert.equal(wipeClipPath(35), 'inset(0 65% 0 0)')
  assert.equal(wipeClipPath(140), 'inset(0 0% 0 0)')
})

test('сравниваем парами: на экране исходник и один кандидат', () => {
  const candidates = ['b', 'c', 'd', 'e']

  assert.deepEqual(visibleSlice('a', candidates, 0, 'overlay'), ['a', 'b'])
  assert.deepEqual(visibleSlice('a', candidates, 2, 'overlay'), ['a', 'd'])

  // и рядом тоже пара, а не три кадра: три мельчат до бесполезности
  const panels = visibleSlice('a', candidates, 0, 'side-by-side')
  assert.deepEqual(panels, ['a', 'b'])
  assert.equal(panels.length, MAX_PANELS)
  assert.equal(MAX_PANELS, 2)

  assert.deepEqual(visibleSlice('a', candidates, 3, 'side-by-side'), ['a', 'e'])
})

test('кандидатов меньше, чем панелей — лишнего не рисуем', () => {
  assert.deepEqual(visibleSlice('a', ['b'], 0, 'side-by-side'), ['a', 'b'])
  assert.deepEqual(visibleSlice('a', [], 0, 'side-by-side'), ['a'])
})

test('оба кадра ложатся в ОДНУ рамку по пропорциям исходника', () => {
  const frame = { width: 800, height: 600 }
  // исходник портретный — рамка портретная, и кандидат обязан лечь в неё же,
  // иначе при разных пропорциях штора режет не по картинке
  const box = overlayFrame({ width: 600, height: 800 }, frame)
  assert.equal(box.height, 600)
  assert.equal(box.width, 450)
  assert.equal(box.x, 175)
  assert.equal(box.y, 0)
})

test('доля шторы считается от экранного положения картинки', () => {
  const frame = { width: 800, height: 600 }
  const box = { x: 200, y: 0, width: 400, height: 600 }

  // 50% рамки = центр экрана = центр картинки
  assert.equal(wipeFractionInBox(50, box, frame), 0.5)
  // левый край картинки — 200/800 = 25% рамки
  assert.equal(wipeFractionInBox(25, box, frame), 0)
  // правый край — 600/800 = 75%
  assert.equal(wipeFractionInBox(75, box, frame), 1)
})

test('курсор вне картинки прижимает штору к её краю, а не выходит за неё', () => {
  const frame = { width: 800, height: 600 }
  const box = { x: 200, y: 0, width: 400, height: 600 }
  assert.equal(wipeFractionInBox(0, box, frame), 0)
  assert.equal(wipeFractionInBox(100, box, frame), 1)
})

test('зум задаётся РАЗМЕРОМ коробки — иначе теряется разрешение', () => {
  const frame = { width: 800, height: 600 }
  const box = { x: 200, y: 0, width: 400, height: 600 }

  // без зума ничего не меняется
  assert.deepEqual(zoomedBox(box, frame, { scale: 1, x: 0, y: 0 }), box)

  // вдвое от центра рамки: картинка занимает по экрану 0…800
  const twice = zoomedBox(box, frame, { scale: 2, x: 0, y: 0 })
  assert.equal(twice.width, 800)
  assert.equal(twice.height, 1200)
  assert.equal(twice.x, 0)
  assert.equal(twice.y, -300)

  // сдвиг просто добавляется поверх
  const panned = zoomedBox(box, frame, { scale: 2, x: 200, y: 40 })
  assert.equal(panned.x, 200)
  assert.equal(panned.y, -260)
})

test('штора после зума и сдвига совпадает с новым положением кадра', () => {
  const frame = { width: 800, height: 600 }
  const box = zoomedBox({ x: 200, y: 0, width: 400, height: 600 }, frame, { scale: 2, x: 200, y: 0 })
  // кадр лежит на экране 200…1000, значит центр рамки — первая четверть кадра
  assert.equal(wipeFractionInBox(50, box, frame), 0.25)
  assert.equal(wipeFractionInBox(75, box, frame), 0.5)
})

test('нулевая рамка не роняет расчёт шторы', () => {
  const zero = { x: 0, y: 0, width: 0, height: 0 }
  assert.equal(wipeFractionInBox(50, zero, { width: 0, height: 0 }), 1)
})

test('натуральный размер берётся с запасным вариантом для старых досок', () => {
  assert.deepEqual(naturalSize({ naturalWidth: 1200, naturalHeight: 800, w: 300, h: 200 }), {
    width: 1200,
    height: 800,
  })
  // старая доска без natural* — пропорции те же, берём размер на холсте
  assert.deepEqual(naturalSize({ w: 300, h: 200 }), { width: 300, height: 200 })
  assert.deepEqual(naturalSize({ naturalWidth: 0, naturalHeight: 0, w: 300, h: 200 }), {
    width: 300,
    height: 200,
  })
})

test('листание идёт по кругу', () => {
  assert.equal(wrapCursor(0, 3), 0)
  assert.equal(wrapCursor(3, 3), 0)
  assert.equal(wrapCursor(-1, 3), 2)
  assert.equal(wrapCursor(5, 3), 2)
  assert.equal(wrapCursor(1, 0), 0)
})
