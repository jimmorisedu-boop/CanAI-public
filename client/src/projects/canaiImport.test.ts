// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { afterEach, test } from 'node:test'
import JSZip from 'jszip'
import { importCanaiProject } from './canaiImport'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const originalFileReader = globalThis.FileReader

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: originalFileReader })
})

const item = { id: 'text-1', kind: 'text', x: 10, y: 20, w: 200, h: 100, text: 'Доска из архива' }
const snapshot = { version: 1, items: [item], camera: { x: 4, y: 5, scale: 2 } }

async function fixture(failure: 'none' | 'write' | 'response') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
  })
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      onload?: (event: unknown) => void
      readAsArrayBuffer(blob: Blob) {
        void blob.arrayBuffer().then((result) => this.onload?.({ target: { result } }))
      }
    },
  })
  const bytes = await new JSZip()
    .file('manifest.json', JSON.stringify({ format: 'canai', version: 1, title: 'Импорт' }))
    .file('project.json', JSON.stringify(snapshot))
    .generateAsync({ type: 'uint8array' })
  const file = new File([bytes], 'fixture.canai')
  const boards = new Map<string, unknown>([['original', { original: true }]])
  let nextId = 0
  // Сетевая граница; сам импортёр и api.request остаются настоящими.
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { 'Content-Type': 'application/json' },
    })
    if (url === '/api/projects' && init?.method === 'POST') {
      if (body.initialSnapshot !== undefined && failure === 'write') {
        return json({ error: 'Ошибка записи снимка' }, 500)
      }
      const project = { id: `import-${++nextId}`, name: body.name, createdAt: 1, updatedAt: 1, pinned: false }
      boards.set(project.id, body.initialSnapshot ?? null)
      if (failure === 'response') throw new TypeError('Ответ потерян после записи')
      return json({ project })
    }
    const id = new URL(url, 'http://local').searchParams.get('project')!
    if (url.startsWith('/api/project?') && !init?.method) return json({ snapshot: boards.get(id), revision: 0 })
    if (url.startsWith('/api/project?') && init?.method === 'POST') {
      if (failure === 'write') return json({ error: 'Ошибка записи снимка' }, 500)
      boards.set(id, body.snapshot)
      return json({ ok: true, revision: 1 })
    }
    if (init?.method === 'DELETE') {
      boards.delete(url.split('/').pop()!)
      return json({ ok: true })
    }
    throw new Error(`Неожиданный запрос: ${url}`)
  }
  return { file, boards, bytes }
}

test('ошибка записи импорта и повтор не оставляют пустых досок', async () => {
  const { file, boards, bytes } = await fixture('write')
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(importCanaiProject(file), /Could not save the board snapshot/u)
    assert.deepEqual([...boards], [['original', { original: true }]])
  }
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes, 'исходный архив остался цел')
})

test('потерянный ответ создания оставляет сохранённый импорт и исходную доску', async () => {
  const { file, boards } = await fixture('response')
  await assert.rejects(importCanaiProject(file))
  assert.deepEqual([...boards], [['original', { original: true }], ['import-1', snapshot]])
})

test('успешный импорт возвращает доску с полным снимком', async () => {
  const { file, boards } = await fixture('none')
  const project = await importCanaiProject(file)
  assert.equal(project.name, 'Импорт')
  assert.deepEqual(boards.get(project.id), snapshot)
  assert.deepEqual(boards.get('original'), { original: true })
})
