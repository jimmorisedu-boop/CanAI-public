import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runMacroGraph, MacroCancelledError, type MacroRunContext } from './macroEngine.js'
import { deliveringNodeIds, topoOrder, type MacroGraph, type MacroResult } from './macroGraph.js'

// Движок макросов переехал из браузера сюда. Тесты повторяют правила, которые
// в браузерной версии писались по следам реальных потерь: сбой ветки не рвёт
// прогон, легаси-графы работают, отмена доводится до конца.

function node(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, data: { kind, prompt: 'п', ...extra } }
}

function harness(graph: MacroGraph, overrides: Partial<MacroRunContext> = {}) {
  const patches: Array<{ id: string; status?: string; error?: string }> = []
  const generated: string[] = []
  const outputs: Array<{ nodeId: string; result: MacroResult }> = []
  const context: MacroRunContext = {
    graph,
    seedRefs: [],
    generate: async ({ node: target }) => {
      generated.push(target.id)
      return { url: `/media/${target.id}.png`, mime: 'image/png' }
    },
    muxAudio: async () => ({ url: '/media/mux.mp4', mime: 'video/mp4' }),
    extractAudio: async () => ({ url: '/media/track.mp3', mime: 'audio/mpeg' }),
    onNode: (id, patch) => patches.push({ id, status: patch.status, error: patch.error }),
    onOutput: (result, nodeId) => {
      outputs.push({ nodeId, result })
    },
    ...overrides,
  }
  return { context, patches, generated, outputs }
}

test('порядок обхода уважает связи', () => {
  const graph: MacroGraph = {
    nodes: [node('b', 'image'), node('a', 'note')],
    edges: [{ id: 'e', source: 'a', target: 'b', targetHandle: 'prompt' }],
  }
  assert.deepEqual(topoOrder(graph)?.map((n) => n.id), ['a', 'b'])
})

test('цикл не выполняется, а называется словами', async () => {
  const graph: MacroGraph = {
    nodes: [node('a', 'image'), node('b', 'image')],
    edges: [
      { id: 'e1', source: 'a', target: 'b', targetHandle: 'prompt' },
      { id: 'e2', source: 'b', target: 'a', targetHandle: 'prompt' },
    ],
  }
  assert.equal(topoOrder(graph), null)
  await assert.rejects(() => runMacroGraph(harness(graph).context), /Graph contains a cycle/u)
})

test('текст ноты течёт в промпт следующей ноды', async () => {
  const graph: MacroGraph = {
    nodes: [node('note', 'note', { prompt: 'кот в скафандре' }), node('img', 'image', { prompt: 'акварель' })],
    edges: [{ id: 'e', source: 'note', target: 'img', targetHandle: 'prompt' }],
  }
  const prompts: string[] = []
  const h = harness(graph, {
    generate: async ({ prompt }) => {
      prompts.push(prompt)
      return { url: '/media/a.png', mime: 'image/png' }
    },
  })
  await runMacroGraph(h.context)
  assert.deepEqual(prompts, ['кот в скафандре\n\nакварель'])
})

test('сбой одной ветки не рвёт независимые', async () => {
  // Ради этого правила движок и переписывали в браузере: раньше первая же
  // ошибка обрывала прогон, и уже оплаченные ветки пропадали.
  const graph: MacroGraph = {
    nodes: [node('good', 'image'), node('bad', 'image'), node('out', 'output')],
    edges: [
      { id: 'e1', source: 'good', target: 'out', sourceHandle: 'image' },
      { id: 'e2', source: 'bad', target: 'out', sourceHandle: 'image' },
    ],
  }
  const h = harness(graph, {
    generate: async ({ node: target }) => {
      if (target.id === 'bad') throw new Error('модель отказала')
      return { url: '/media/good.png', mime: 'image/png' }
    },
  })
  const { delivered } = await runMacroGraph(h.context)
  assert.equal(delivered, 1)
  assert.equal(h.patches.some((p) => p.id === 'bad' && p.error === 'модель отказала'), true)
})

test('потомок упавшей ноды не считается', async () => {
  const graph: MacroGraph = {
    nodes: [node('bad', 'image'), node('child', 'image')],
    edges: [{ id: 'e', source: 'bad', target: 'child', targetHandle: 'ref1' }],
  }
  const tried: string[] = []
  const h = harness(graph, {
    generate: async ({ node: target }) => {
      tried.push(target.id)
      if (target.id === 'bad') throw new Error('нет')
      return { url: '/media/x.png', mime: 'image/png' }
    },
  })
  await assert.rejects(() => runMacroGraph(h.context))
  assert.deepEqual(tried, ['bad'])
  assert.equal(h.patches.some((p) => p.id === 'child' && p.error === 'branch was interrupted above'), true)
})

test('нода из прежней версии роняет только себя', async () => {
  const graph: MacroGraph = {
    nodes: [node('old', 'wait'), node('img', 'image'), node('out', 'output')],
    edges: [{ id: 'e', source: 'img', target: 'out', sourceHandle: 'image' }],
  }
  const h = harness(graph)
  const { delivered } = await runMacroGraph(h.context)
  assert.equal(delivered, 1)
  assert.equal(h.patches.some((p) => p.id === 'old' && /previous app version/u.test(p.error ?? '')), true)
})

test('легаси-граф без «Выхода» кладёт на доску листья', async () => {
  const graph: MacroGraph = {
    nodes: [node('a', 'image'), node('b', 'image')],
    edges: [{ id: 'e', source: 'a', target: 'b', targetHandle: 'ref1' }],
  }
  assert.deepEqual(deliveringNodeIds(graph), ['b'])
  const h = harness(graph)
  const { delivered } = await runMacroGraph(h.context)
  assert.equal(delivered, 1)
})

test('заглушку занимают только те ноды, чей результат едет на доску', () => {
  const graph: MacroGraph = {
    nodes: [node('mid', 'image'), node('leaf', 'image'), node('out', 'output')],
    edges: [
      { id: 'e1', source: 'mid', target: 'leaf', targetHandle: 'ref1' },
      { id: 'e2', source: 'leaf', target: 'out', sourceHandle: 'image' },
    ],
  }
  // Промежуточная нода на доску не едет — заглушку ей выделять не за что.
  assert.deepEqual(deliveringNodeIds(graph), ['leaf'])
})

test('результат доставляющей ноды не кладётся на доску дважды', async () => {
  // Задача уже знает свою заглушку и встанет туда сама (или это сделает
  // сервер). Второй раз через onOutput класть нельзя — вышел бы дубль.
  const graph: MacroGraph = {
    nodes: [node('leaf', 'image'), node('out', 'output')],
    edges: [{ id: 'e', source: 'leaf', target: 'out', sourceHandle: 'image' }],
  }
  const h = harness(graph, { placeholderByNode: { leaf: 'slot-1' } })
  const { delivered } = await runMacroGraph(h.context)
  assert.equal(delivered, 1)
  assert.deepEqual(h.outputs, [])
})

test('отмена прекращает прогон', async () => {
  const graph: MacroGraph = {
    nodes: [node('a', 'image'), node('b', 'image')],
    edges: [{ id: 'e', source: 'a', target: 'b', targetHandle: 'ref1' }],
  }
  let done = 0
  const h = harness(graph, {
    generate: async ({ node: target }) => {
      done += 1
      return { url: `/media/${target.id}.png`, mime: 'image/png' }
    },
    isCancelled: () => done >= 1,
  })
  await assert.rejects(() => runMacroGraph(h.context), MacroCancelledError)
  assert.equal(done, 1)
})

test('звуковые операции идут своей веткой, а не генерацией', async () => {
  const graph: MacroGraph = {
    nodes: [node('media', 'media', { result: { url: '/media/clip.mp4', mime: 'video/mp4' } }), node('cut', 'extractAudio')],
    edges: [{ id: 'e', source: 'media', target: 'cut', targetHandle: 'video1', sourceHandle: 'video' }],
  }
  const h = harness(graph)
  await runMacroGraph(h.context)
  assert.deepEqual(h.generated, [])
  assert.equal(h.outputs.at(-1)?.result.mime, 'audio/mpeg')
})

test('несовместимая связь называется словами', async () => {
  const graph: MacroGraph = {
    nodes: [node('vid', 'video'), node('img', 'image')],
    edges: [{ id: 'e', source: 'vid', target: 'img', sourceHandle: 'image', targetHandle: 'ref1' }],
  }
  const h = harness(graph, {
    generate: async ({ node: target }) => (target.id === 'vid'
      ? { url: '/media/a.mp4', mime: 'video/mp4' }
      : { url: '/media/a.png', mime: 'image/png' }),
  })
  await assert.rejects(() => runMacroGraph(h.context), /Incompatible connection/u)
})

// ── правила, переехавшие вместе с движком из браузера ──────────────────────

test('несовместимая связь не запускает платную генерацию', () => {
  // Не «падает с ошибкой», а именно НЕ ПЛАТИТ: раньше это проверялось на
  // браузерном движке (modelContracts.repro), и правило переехало вместе с ним.
  const graph: MacroGraph = {
    nodes: [
      node('media', 'media', { result: { url: '/media/source.mp4', mime: 'video/mp4' } }),
      node('image', 'image', { prompt: 'постер' }),
      node('out', 'output'),
    ],
    edges: [
      { id: 'wrong', source: 'media', sourceHandle: 'image', target: 'image', targetHandle: 'ref1' },
      { id: 'result', source: 'image', sourceHandle: 'out', target: 'out', targetHandle: 'in-image' },
    ],
  }
  let paid = 0
  const h = harness(graph, {
    generate: async () => {
      paid += 1
      return { url: '/media/x.png', mime: 'image/png' }
    },
  })
  return runMacroGraph(h.context).then(
    () => assert.fail('несовместимая связь обязана прерывать ветку'),
    (error: unknown) => {
      assert.equal(paid, 0, 'платная генерация не должна была запуститься')
      assert.match(error instanceof Error ? error.message : '', /video.*«Image»|Incompatible/i)
    },
  )
})

test('аудиофайл уходит в модель именно звуковым референсом', async () => {
  const graph: MacroGraph = {
    nodes: [
      node('audio', 'media', { result: { url: '/media/track.mp3', mime: 'audio/mpeg' } }),
      node('video', 'video', { prompt: 'смонтируй под ритм', model: 'seedance-2' }),
      node('out', 'output'),
    ],
    edges: [
      { id: 'audio-ref', source: 'audio', sourceHandle: 'audio', target: 'video', targetHandle: 'frame1' },
      { id: 'video-out', source: 'video', sourceHandle: 'out', target: 'out', targetHandle: 'in-video' },
    ],
  }
  let captured: unknown
  const h = harness(graph, {
    generate: async ({ refs }) => {
      captured = refs
      return { url: '/media/result.mp4', mime: 'video/mp4' }
    },
  })
  await runMacroGraph(h.context)
  assert.deepEqual(captured, [{ kind: 'audio', src: '/media/track.mp3' }])
})

test('локальные операции со звуком не уходят в платную генерацию', () => {
  // Склейка и извлечение считаются нашим ffmpeg. Попади их kind в /api/generate —
  // сервер получил бы несуществующий тип задачи. Сторож переехал из
  // nodeModel.test вместе с движком.
  const source = readFileSync(new URL('./macroEngine.ts', import.meta.url), 'utf8')
  assert.match(source, /kind === 'muxAudio' \|\| node\.data\.kind === 'extractAudio'/)
  assert.ok(
    source.indexOf("kind === 'muxAudio'") < source.indexOf('context.generate('),
    'локальная ветка обязана стоять ДО генерации',
  )
})

// ── продолжение прогона после перезапуска приложения ──────────────────────

test('посчитанный до перезапуска шаг не считается заново', async () => {
  // Главное правило продолжения: шаг перезапускается, только если у него нет
  // ни сохранённого результата, ни живой задачи. Иначе рестарт означал бы
  // повторную оплату уже сделанной работы.
  const graph: MacroGraph = {
    nodes: [node('first', 'image'), node('second', 'image'), node('out', 'output')],
    edges: [
      { id: 'e1', source: 'first', target: 'second', targetHandle: 'ref1', sourceHandle: 'image' },
      { id: 'e2', source: 'second', target: 'out', sourceHandle: 'image' },
    ],
  }
  const h = harness(graph, {
    initialResults: { first: { url: '/media/first.png', mime: 'image/png' } },
  })
  const { delivered } = await runMacroGraph(h.context)
  assert.deepEqual(h.generated, ['second'], 'первый шаг обязан быть пропущен')
  assert.equal(delivered, 1)
})

test('результат первого шага доезжает до второго и после перезапуска', async () => {
  const graph: MacroGraph = {
    nodes: [node('first', 'image'), node('second', 'image')],
    edges: [{ id: 'e', source: 'first', target: 'second', targetHandle: 'ref1', sourceHandle: 'image' }],
  }
  let seen: unknown
  const h = harness(graph, {
    initialResults: { first: { url: '/media/first.png', mime: 'image/png' } },
    generate: async ({ refs }) => {
      seen = refs
      return { url: '/media/second.png', mime: 'image/png' }
    },
  })
  await runMacroGraph(h.context)
  assert.deepEqual(seen, [{ kind: 'image', src: '/media/first.png' }])
})

test('уже доставленный результат не кладётся на доску второй раз', async () => {
  // Легаси-граф: лист доставляет сам. После перезапуска повторная доставка
  // положила бы на доску второй экземпляр одной и той же картинки.
  const graph: MacroGraph = {
    nodes: [node('leaf', 'extractAudio')],
    edges: [],
  }
  const h = harness(graph, {
    initialResults: { leaf: { url: '/media/track.mp3', mime: 'audio/mpeg' } },
    deliveredNodeIds: ['leaf'],
  })
  const { delivered } = await runMacroGraph(h.context)
  assert.deepEqual(h.outputs, [], 'второй раз класть нельзя')
  assert.equal(delivered, 1, 'но в счёт доставленного он входит')
})

test('о новой доставке сообщается наружу — иначе она не переживёт рестарт', async () => {
  const graph: MacroGraph = { nodes: [node('leaf', 'extractAudio')], edges: [] }
  const delivered: string[] = []
  const h = harness(graph, {
    initialResults: { leaf: { url: '/media/track.mp3', mime: 'audio/mpeg' } },
    onDelivered: (nodeId) => delivered.push(nodeId),
  })
  await runMacroGraph(h.context)
  assert.deepEqual(delivered, ['leaf'])
})
