import assert from 'node:assert/strict'
import test from 'node:test'
import { fileNameFromSrc, refChipFallback, retryRefSrc } from './refChipFallback'

test('плашка называет файл и объясняет, что случилось', () => {
  const failed = refChipFallback({ kind: 'image', label: 'морской_закат.png', src: '/media/морской_закат.png' })
  assert.equal(failed.name, 'морской_закат.png')
  assert.equal(failed.reason, 'Image failed to load')
  assert.match(failed.action, /retry/)
})

test('род слова не подставляется одной строкой на всех', () => {
  assert.equal(refChipFallback({ kind: 'video', label: 'clip.mp4' }).reason, 'Video failed to load')
  assert.equal(refChipFallback({ kind: 'audio', label: 'дорожка.mp3' }).reason, 'Audio failed to load')
  assert.equal(refChipFallback({ kind: 'странное', label: 'x' }).reason, 'File failed to load')
})

test('родовая подпись уступает имени файла из адреса', () => {
  // `itemToRef` подставляет «картинка», когда у объекта нет имени, — такая
  // подпись не отличает один сорвавшийся чип от другого.
  assert.equal(
    refChipFallback({ kind: 'image', label: 'картинка', src: '/media/fal-1737281923.png' }).name,
    'fal-1737281923.png',
  )
  // ⚠️ У вложений СЕТЕВОЙ доски подпись машинная — «изображение» для всех
  // сразу; такая тоже уступает адресу.
  assert.equal(
    refChipFallback({ kind: 'image', label: 'изображение', src: '/api/cloud-assets/assets/ast_7Kd' }).name,
    'ast_7Kd',
  )
  // Совсем без имени и без адреса остаётся хотя бы вид.
  assert.equal(refChipFallback({ kind: 'image' }).name, 'Image')
})

test('строку запроса срезаем ДО разбора пути', () => {
  // ⚠️ После внешнего редактора у ссылки есть `?v=<mtime>`: без среза именем
  // файла стало бы «кадр.png?v=123».
  assert.equal(fileNameFromSrc('/media/кадр.png?v=1737'), 'кадр.png')
  assert.equal(fileNameFromSrc('/media/%D0%BA%D0%B0%D0%B4%D1%80.png'), 'кадр.png')
  assert.equal(fileNameFromSrc(undefined), '')
  // Кривая процентная последовательность не должна ронять разбор.
  assert.equal(fileNameFromSrc('/media/100%.png'), '100%.png')
})

test('повтор идёт по новому адресу, но своей строки запроса не теряет', () => {
  const src = '/media/кадр.png?v=1737'
  assert.equal(retryRefSrc(src, 0), src, 'первая попытка — обычный адрес и обычный кэш')
  assert.equal(retryRefSrc(src, 1), '/media/кадр.png?v=1737&canai-retry=1')
  assert.equal(retryRefSrc('/media/a.png', 2), '/media/a.png?canai-retry=2')
  assert.equal(retryRefSrc('/media/a.png#t', 1), '/media/a.png?canai-retry=1#t')
})
