import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { MEDIA_TYPES, extForMime, mimeForExt } from './mediaTypes.js'

// Сохранили файл — потом прочитали его же. Пока таблиц было две, круг не
// замыкался: storage сохранял image/gif как .gif, а refs про такое расширение
// не знал и отдавал файл на fal как image/png.
test('сохранённый файл читается тем же типом', () => {
  for (const type of MEDIA_TYPES) {
    const ext = extForMime(type.mime)
    assert.notEqual(ext, 'bin', `не знаем расширения для ${type.mime}`)
    assert.equal(mimeForExt(ext), type.mime, `круг не замкнулся на ${type.mime}`)
  }
})

test('синонимы mime дают то же расширение, что канонический', () => {
  assert.equal(extForMime('audio/mp3'), extForMime('audio/mpeg'))
  assert.equal(extForMime('audio/x-wav'), extForMime('audio/wav'))
})

test('регистр в заголовке не мешает', () => {
  assert.equal(extForMime('IMAGE/PNG'), 'png')
  assert.equal(mimeForExt('JPEG'), 'image/jpeg')
})

// «bin» честнее чужого расширения: неизвестный файл не должен притворяться
// картинкой в имени.
test('незнакомый тип не притворяется знакомым', () => {
  assert.equal(extForMime('application/octet-stream'), 'bin')
})

// Клиент собирает zip у себя и держит СВОЮ маленькую таблицу — общий модуль
// между пакетами взять неоткуда. Разъехаться она не должна: файл в архиве
// получил бы расширение, не совпадающее с тем, под которым он лежит на диске.
test('запасная таблица клиента не противоречит серверной', () => {
  const root = path.resolve(fileURLToPath(import.meta.url), '../../..')
  const source = readFileSync(
    path.join(root, 'client/src/spaces/canvas/konva/mediaFileName.ts'),
    'utf8',
  )
  const table = source.match(/const EXT_BY_MIME[^{]*\{([\s\S]*?)\}/)?.[1]
  assert.ok(table, 'в mediaFileName не найдена таблица расширений')

  const pairs = [...table.matchAll(/'([^']+)':\s*'([^']+)'/g)]
  assert.ok(pairs.length > 0, 'таблица клиента пуста')
  for (const [, mime, ext] of pairs) {
    assert.equal(extForMime(mime), ext, `клиент и сервер расходятся на ${mime}`)
  }
})
