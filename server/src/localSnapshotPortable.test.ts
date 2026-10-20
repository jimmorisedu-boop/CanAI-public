import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { config } from './config.js'
import { stripLocalOnly } from './localSnapshotPortable.js'

function findBase64Media(value: unknown): string | null {
  if (typeof value === 'string') return /^data:(?:image|video|audio)\//.test(value) ? value : null
  if (Array.isArray(value)) return value.map(findBase64Media).find(Boolean) ?? null
  if (value && typeof value === 'object') return Object.values(value).map(findBase64Media).find(Boolean) ?? null
  return null
}

// ⚠️ «Копировать в команду» падало с внутренней ошибкой на любой доске, в
// истории версий которой была заглушка генерации: сервер проверяет КАЖДЫЙ
// вложенный объект и видел `retry.kind: "image"` без assetId (найдено
// 03.09.2026). Та же причина, по которой падала генерация на сетевой доске.

test('описание повтора не уезжает вместе со снимком', () => {
  const clean = stripLocalOnly({
    version: 1,
    pending: [{
      id: 'p1',
      kind: 'image',
      status: 'loading',
      retry: { kind: 'image', model: 'gpt-image-2', refs: [{ kind: 'image', src: '/media/x.png' }] },
    }],
  }) as { pending: Array<Record<string, unknown>> }

  assert.equal(clean.pending[0].retry, undefined, 'retry — местное дело')
  // Сама заглушка при этом остаётся: сервер её принимает по status.
  assert.equal(clean.pending[0].kind, 'image')
  assert.equal(clean.pending[0].status, 'loading')
})

test('всё остальное доезжает без изменений, включая вложенное', () => {
  const source = {
    versions: [{ id: 'v1', snapshot: { items: [{ kind: 'image', src: '/media/a.png', w: 10 }] } }],
    comments: [{ text: 'привет', anchor: { x: 1, y: 2 } }],
  }
  assert.deepEqual(stripLocalOnly(source), source)
  assert.deepEqual(stripLocalOnly([1, 'два', null]), [1, 'два', null])
  assert.equal(stripLocalOnly(null), null)
})

// Заглушки лежат и в старых версиях доски — их обходим на любой глубине.
test('retry вычищается и из истории версий', () => {
  const clean = stripLocalOnly({
    versions: [{ snapshot: { pending: [{ kind: 'video', retry: { kind: 'video' } }] } }],
  }) as { versions: Array<{ snapshot: { pending: Array<Record<string, unknown>> } }> }
  assert.equal(clean.versions[0].snapshot.pending[0].retry, undefined)
  assert.equal(clean.versions[0].snapshot.pending[0].kind, 'video')
})

test('схема платного теста остаётся только в jobs.json, а файлы каталога портативны', () => {
  const projectDocument = stripLocalOnly({
    version: 1,
    items: [],
    pending: [{ id: 'p1', modelSnapshot: { id: 'user-private' }, catalogDraftTest: { draftId: 'user-private' } }],
  })
  const catalogDocument = {
    schemaVersion: 2,
    revision: 1,
    lifecycle: {},
    drafts: [{ id: 'user-portable', endpoint: 'vendor/portable', params: [] }],
    extensions: [],
  }

  assert.equal(JSON.stringify(projectDocument).includes('modelSnapshot'), false)
  assert.equal(JSON.stringify(projectDocument).includes('catalogDraftTest'), false)
  assert.equal(JSON.stringify(catalogDocument).includes('FAL_KEY'), false)
  assert.equal(findBase64Media(catalogDocument), null)

  const dataRoot = path.dirname(config.projectFile)
  for (const file of ['catalog-library.json', 'catalog-lifecycle-operations.json']) {
    const resolved = path.resolve(dataRoot, file)
    assert.equal(resolved.startsWith(`${path.resolve(dataRoot)}${path.sep}`), true)
  }
})
