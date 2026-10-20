import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MacroGraph } from './macroGraph.js'
import type { MacroRunState } from './macroRuns.js'

// Находка 7 аудита моделей 19.10.2026: шаг макроса с num_images = 4 уходил в
// fal как есть — платили за четыре картинки, а на доску вставала первая.
// Обычный запуск с холста такое отклоняет; шаг макроса приводит к одной.

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Макрос не завершился вовремя')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('шаг макроса просит у fal ровно одну картинку, сколько бы ни лежало в ноде', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-macro-single-'))
  process.env.CANAI_DATA_DIR = dataDir
  process.env.CANAI_ENV_FILE = path.join(dataDir, 'missing.env')
  process.env.CANAI_MOCK = '1'
  const [macros, { jobs }, projects] = await Promise.all([
    import('./macroRuns.js'), import('./jobs.js'), import('./projects.js'),
  ])
  t.after(async () => {
    macros.resetMacroRuns()
    for (const job of jobs.all()) jobs.remove(job.id)
    await jobs.persistNow()
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const board = await projects.createProject('Одна картинка')
  const graph: MacroGraph = {
    nodes: [
      // старый или перенесённый из файла макрос: ручки количества на ноде нет, а значение лежит
      { id: 'img', data: { kind: 'image', prompt: 'кот', model: 'nano-banana', params: { resolution: '1K', num_images: 4 } } },
      { id: 'out', data: { kind: 'output' } },
    ],
    edges: [{ id: 'edge', source: 'img', target: 'out', sourceHandle: 'out', targetHandle: 'in-image' }],
  }
  const run: MacroRunState = macros.startMacroRun({
    macroId: 'four', macroName: 'Четыре', projectId: board.id, graph, seedRefs: [], placeholderIds: [],
  })
  await waitFor(() => run.status !== 'running')
  assert.equal(run.status, 'done', run.error)
  // задача самой генерации (выход доски получает ещё и свою задачу доставки)
  const job = jobs.all().find((item) => item.model === 'nano-banana')
  assert.ok(job)
  assert.equal(job.params?.num_images, 1)
  assert.equal(job.params?.resolution, '1K')

  assert.deepEqual(macros.singleResultParams({ num_images: 3, seed: 5 }), { num_images: 1, seed: 5 })
  const untouched = { seed: 5 }
  assert.equal(macros.singleResultParams(untouched), untouched)
  assert.equal(macros.singleResultParams(undefined), undefined)
})
