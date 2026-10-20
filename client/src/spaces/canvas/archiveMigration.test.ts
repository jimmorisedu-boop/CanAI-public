// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
// @ts-expect-error Node-типы не подключены к production-клиенту.
import { readFileSync } from 'node:fs'
import { sanitizeArchive } from './konva/archive.js'

const BASE64_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

function archived(src: string) {
  return { id: 'a1', kind: 'image', x: 0, y: 0, w: 100, h: 100, src, archivedAt: 1786012345678 }
}

test('контроль: архив со ссылкой /media/ читается', () => {
  const kept = sanitizeArchive([archived('/media/ok.png')])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].src, '/media/ok.png')
})

test('sanitizeArchive по-прежнему не пускает base64 в доску', () => {
  // Санитайзер прав по инварианту и остаётся последней линией обороны. Просто
  // теперь до него base64 не доезжает — миграция ниже переносит его в файл.
  assert.deepEqual(sanitizeArchive([archived(BASE64_SRC)]), [])
})

test('миграция переносит base64 из архива, а не только из items', () => {
  // Тот же приём сверки исходника, что уже используется в modelParamContract
  // и feedbackComponents: проверяем контракт функции, а не её вывод.
  // Без архива в миграции его записи гибли: перенести в файл было некому,
  // и sanitizeArchive выбрасывал их при следующей загрузке.
  const source = readFileSync(new URL('./projectSync.ts', import.meta.url), 'utf8')
  const migration = /async function migrateInlineMedia[\s\S]*?\n}/.exec(source)?.[0] ?? ''
  assert.ok(migration, 'migrateInlineMedia не найдена — тест устарел')

  for (const collection of ['items', 'assets', 'archive']) {
    assert.match(
      migration,
      new RegExp(`doc\\.${collection}`),
      `коллекция ${collection} выпала из миграции base64`,
    )
  }
  // перенесённый архив обязан попасть в возвращаемый снапшот
  assert.match(migration, /\{\s*\.\.\.doc[\s\S]*archive/)
})
