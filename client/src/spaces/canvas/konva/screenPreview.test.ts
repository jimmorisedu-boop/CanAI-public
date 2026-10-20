import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { previewStep, screenPreviewSrc, stickyPreviewStep } from './screenPreview.js'

const local = '/media/photo.png'

/**
 * ⚠️ Доска команды из 136 картинок весила 860 МБ и грузилась минутами (жалоба
 * 07.09.2026): файлы идут по сети и весят по несколько мегабайт, а на экране
 * объект занимает 100–300 px. Показываем экранное превью — но только показываем.
 */
test('на холсте берётся превью под размер объекта', () => {
  assert.equal(screenPreviewSrc(local, 200), '/media/preview/photo.png?w=256')
  assert.equal(screenPreviewSrc(local, 300), '/media/preview/photo.png?w=512')
  // ⚠️ Крупные ступени — новым адресом: прежние были растянутой 512 и сидят в
  // кэше браузера как неизменные (пункт 3.5, Ф-6).
  assert.equal(screenPreviewSrc(local, 900), '/media/preview/photo.png?w=1024')
  assert.equal(screenPreviewSrc(local, 1500), '/media/preview/photo.png?w=1920')
})

test('повтор загрузки чипа меняет URL превью и не теряет cache-buster', () => {
  assert.equal(
    screenPreviewSrc(`${local}?canai-retry=1`, 96),
    '/media/preview/photo.png?w=256&canai-retry=1',
  )
})

test('приблизили вплотную — показываем оригинал, а не пережатую копию', () => {
  assert.equal(screenPreviewSrc(local, 2400), local)
})

/**
 * ⚠️ Своей доске превью нужно ровно так же, хотя файлы лежат на диске рядом:
 * дело не в сети, а в перерисовке. Замер на доске пользователя (24 картинки
 * по 5,9 Мпикс, масштаб 0.29): кадр из оригиналов 78 мс, из уменьшенных
 * копий 0,03 мс — при бюджете кадра 16 мс это и есть «фризы».
 */
test('местные картинки тоже показываются превью', () => {
  assert.equal(screenPreviewSrc('/media/photo.png', 200), '/media/preview/photo.png?w=256')
  // ⚠️ Строка запроса сохраняется: у местных это `?v=<mtime>` после внешнего
  // редактора, и без неё превью осталось бы прежним.
  assert.equal(screenPreviewSrc('/media/photo.png?v=42', 300), '/media/preview/photo.png?w=512&v=42')
})

test('чужие адреса не трогаем', () => {
  assert.equal(screenPreviewSrc(undefined, 200), undefined)
  assert.equal(screenPreviewSrc('data:image/png;base64,AAA', 200), 'data:image/png;base64,AAA')
  assert.equal(screenPreviewSrc('https://example.com/photo.png', 200), 'https://example.com/photo.png')
})

test('ступени совпадают с серверными: кэш не должен пухнуть', () => {
  assert.equal(previewStep(1), 256)
  assert.equal(previewStep(512), 512)
  assert.equal(previewStep(513), 1024)
  assert.equal(previewStep(Number.NaN), 256)
})

/**
 * ⚠️ item.src обязан остаться оригиналом: с ним работают скачивание, обрезка,
 * скетч, сравнение и генерация. Превью — только то, что рисуется на холсте.
 */
test('превью подставляется лишь при показе картинки', async () => {
  const image = await readFile(new URL('./ImageItem.tsx', import.meta.url), 'utf8')
  assert.match(image, /screenPreviewSrc\(item\.src, previewWidth\.current\)/)

  const zip = await readFile(new URL('./zipExport.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(zip, /screenPreviewSrc/, 'в архив уходит оригинал')
  const crop = await readFile(new URL('./cropApply.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(crop, /screenPreviewSrc/, 'обрезаем оригинал')
  const sketch = await readFile(new URL('./sketchExport.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(sketch, /screenPreviewSrc/, 'скетч склеивается с оригиналом')
})

/**
 * ⚠️ Превью — удобство, а не обязательство: сервер мог ещё не уметь их отдавать
 * (серверные правки доезжают только с перезапуском приложения), файл мог
 * оказаться не картинкой, пережим — не удаться. Дыра на месте картинки хуже
 * медленной загрузки.
 */
test('не загрузилось превью — показываем оригинал', async () => {
  const image = await readFile(new URL('./ImageItem.tsx', import.meta.url), 'utf8')
  // Третьим доводом идёт центр объекта (очередь «от центра кадра», 3.5) —
  // запасным адресом оригинал остаётся вторым.
  assert.match(image, /useImageEl\(shownSrc, item\.src[,)]/, 'оригинал передаётся запасным адресом')
  const media = await readFile(new URL('./media.ts', import.meta.url), 'utf8')
  assert.match(media, /fallbackSrc/)
})

/**
 * ⚠️ Ступень идёт вниз, когда копия крупнее нужной больше чем вдвое. Прежний
 * тест требовал «не понижать никогда» и закреплял ровно то, от чего Firefox
 * падал до 7 кадров в секунду на отдалённой доске: крупные копии копились
 * после каждого приближения и перезаливались в видеокарту на каждом кадре
 * (жалоба 25.09.2026, замер — в stickyPreviewStep).
 */
test('приближение повышает ступень сразу, отдаление понижает только крупную копию', () => {
  assert.equal(stickyPreviewStep(undefined, 256), 256)
  assert.equal(stickyPreviewStep(256, 1024), 1024, 'приблизились — копия чёткая сразу')
  // Мелкие колебания масштаба адрес картинки не трогают.
  assert.equal(previewStep(stickyPreviewStep(600, 300)), 1024, 'вдвое крупнее нужной — остаётся')
  assert.equal(previewStep(stickyPreviewStep(300, 200)), 512)
  // Отдалились сильно — берём мелкую копию.
  assert.equal(previewStep(stickyPreviewStep(1024, 256)), 256)
  assert.equal(previewStep(stickyPreviewStep(1500, 200)), 256)
  // Оригинал держим, только пока он и нужен.
  assert.equal(screenPreviewSrc('/media/a.png', stickyPreviewStep(2600, 1500)), '/media/preview/a.png?w=1920')
  assert.equal(screenPreviewSrc('/media/a.png', stickyPreviewStep(2600, 3000)), '/media/a.png')
  assert.equal(screenPreviewSrc('/media/a.png', stickyPreviewStep(2600, 2000)), '/media/a.png')
})

/**
 * ⚠️ Размеры превью — НЕ размеры картинки: на них держатся обрезка, экспорт и
 * подсказка при наведении.
 */
test('натуральное разрешение не берётся из превью', async () => {
  const image = await readFile(new URL('./ImageItem.tsx', import.meta.url), 'utf8')
  assert.match(image, /showingPreview/)
  assert.match(image, /persistNaturalSize && !showingPreview/)
  assert.match(image, /item\.naturalWidth \?\? img\.naturalWidth/)
})

/**
 * ⚠️ «Просим оригинал» ещё не значит «показан оригинал»: прежняя уменьшенная
 * копия держится на экране, пока он грузится. Фигура записывала её размер как
 * натуральный, а следом — настоящий: на сетевой доске это две правки на каждую
 * картинку при каждом приближении (журнал доски 01.10.2026).
 */
test('натуральное разрешение пишется только с самого оригинала', async () => {
  for (const file of ['./ImageItem.tsx', './GifItem.tsx']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /!showingPreview && isImageLoadedFrom\(img, item\.src\)/, file)
  }
  const media = await readFile(new URL('./media.ts', import.meta.url), 'utf8')
  assert.match(media, /imageCache\.get\(src\) === image/)
})
