// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import {
  cleanMacroGraph,
  macroFingerprint,
  macroRunnable,
  parseStoredMacroGraph,
} from './macroPersistence.js'
import type { CanaiNode } from './types.js'
import { seedDefaults } from '../../ui/ParamControls.js'
import { resolveNodeModel } from './nodeModel.js'
import type { CatalogModel } from '../../types.js'

test('пользовательская модель и параметры ноды переживают сохранение и открытие макроса', () => {
  const model: CatalogModel = {
    id: 'custom-12345678-1234-4123-8123-123456789abc', name: 'Своя модель', kind: 'image', refs: false,
    params: [
      { name: 'custom__enabled', label: 'Включено', widget: 'boolean', default: true },
      { name: 'custom__strength', label: 'Сила', widget: 'number', default: 1, min: 0, max: 5 },
    ],
  }
  const preset = resolveNodeModel([model], 'image', model.id, false, false)!
  const saved = cleanMacroGraph([{
    id: 'node-custom', type: 'gen', position: { x: 0, y: 0 },
    data: {
      kind: 'image', status: 'running', model: preset.id, prompt: 'Свет',
      params: { ...seedDefaults(preset.params), custom__enabled: false, custom__strength: 2.5 },
      progress: '50%',
    },
  }], [])
  const restored = parseStoredMacroGraph(JSON.parse(JSON.stringify(saved)))
  assert.equal(restored.nodes[0]?.data.model, 'custom-12345678-1234-4123-8123-123456789abc')
  assert.deepEqual(restored.nodes[0]?.data.params, { custom__enabled: false, custom__strength: 2.5 })
  assert.equal(restored.nodes[0]?.data.status, 'idle')
})

test('macro with a disconnected output is a draft, not runnable', () => {
  assert.equal(
    macroRunnable({
      nodes: [
        {
          id: 'output',
          type: 'gen',
          position: { x: 0, y: 0 },
          data: { kind: 'output', status: 'idle' },
        },
      ],
      edges: [],
    }),
    false,
  )
})

test('cleanMacroGraph removes transient runtime fields', () => {
  const node: CanaiNode = {
    id: 'n1',
    type: 'gen',
    position: { x: 0, y: 0 },
    data: {
      kind: 'image',
      prompt: 'тест',
      status: 'running',
      progress: '50%',
      error: 'старое',
      result: { url: '/media/old.png' },
      outputHistory: [{ url: '/media/old.png' }],
      viewIndex: 0,
    },
  }
  const graph = cleanMacroGraph([node], [])

  assert.equal(graph.nodes[0].data.status, 'idle')
  assert.equal(graph.nodes[0].data.progress, undefined)
  assert.equal(graph.nodes[0].data.result, undefined)
  assert.equal(graph.nodes[0].data.outputHistory, undefined)
})

test('fingerprint changes for user data but not runtime or selection state', () => {
  const base: CanaiNode = {
    id: 'n1',
    type: 'gen',
    position: { x: 0, y: 0 },
    data: { kind: 'note', prompt: 'A', status: 'idle' },
  }
  const running: CanaiNode = {
    ...base,
    selected: true,
    measured: { width: 240, height: 150 },
    resizing: true,
    data: { ...base.data, status: 'running', progress: '50%' },
  }
  const edited: CanaiNode = {
    ...base,
    data: { ...base.data, prompt: 'B' },
  }

  assert.equal(
    macroFingerprint('Имя', cleanMacroGraph([base], [])),
    macroFingerprint('Имя', cleanMacroGraph([running], [])),
  )
  assert.notEqual(
    macroFingerprint('Имя', cleanMacroGraph([base], [])),
    macroFingerprint('Имя', cleanMacroGraph([edited], [])),
  )
  const persisted = cleanMacroGraph([running], []).nodes[0] as unknown as Record<string, unknown>
  assert.equal('measured' in persisted, false)
  assert.equal('resizing' in persisted, false)
})

test('parseStoredMacroGraph rejects legacy graphs with non-array nodes or edges', () => {
  assert.throws(
    () => parseStoredMacroGraph({ nodes: {}, edges: [] }),
    /corrupt|arrays/i,
  )
  assert.throws(
    () => parseStoredMacroGraph({ nodes: [], edges: 'broken' }),
    /corrupt|arrays/i,
  )
})

test('размеры ноды не попадают в файл — иначе они прижмут обёртку навсегда', () => {
  const node: CanaiNode = {
    id: 'n1',
    type: 'gen',
    position: { x: 0, y: 0 },
    // так выглядит нода после работы React Flow: замер DOM осел прямо в ней
    width: 240,
    height: 150,
    measured: { width: 240, height: 150 },
    selected: true,
    data: { kind: 'note', prompt: 'A', status: 'idle' },
  }
  const saved = cleanMacroGraph([node], []).nodes[0] as Record<string, unknown>

  assert.equal('width' in saved, false)
  assert.equal('height' in saved, false)
  assert.equal('measured' in saved, false)
  assert.equal('selected' in saved, false)
  // всё, что действительно описывает граф, на месте
  assert.equal(saved.id, 'n1')
  assert.deepEqual(saved.position, { x: 0, y: 0 })
  assert.equal((saved.data as { prompt: string }).prompt, 'A')
})
