import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { CatalogModel } from '../../types'
import { canConnect, NODE_PORTS, portsFor, metaFor, isKnownNodeKind, visibleOutputs } from './ports'
import { resolveNodeModel, toBaseModelId } from './nodeModel'
import { effectiveModel } from '../canvas/genOptions'

const models: CatalogModel[] = [
  {
    id: 'seedance-2',
    name: 'Seedance 2.0',
    kind: 'video',
    refs: false,
    pairId: 'seedance-2-i2v',
    videoPairId: 'seedance-2-refs',
    params: [],
  },
  {
    id: 'seedance-2-i2v',
    name: 'Seedance 2.0 — оживить картинку',
    kind: 'video',
    refs: true,
    params: [],
  },
  {
    id: 'seedance-2-refs',
    name: 'Seedance 2.0 — редактировать видео',
    kind: 'video',
    refs: true,
    videoRefs: true,
    params: [],
  },
  {
    id: 'nano-banana',
    name: 'Nano Banana',
    kind: 'image',
    refs: false,
    pairId: 'nano-banana-edit',
    params: [],
  },
  {
    id: 'nano-banana-edit',
    name: 'Nano Banana — по референсам',
    kind: 'image',
    refs: true,
    params: [],
  },
  {
    id: 'ideogram-character-edit',
    name: 'Ideogram Character Edit',
    kind: 'image',
    refs: true,
    params: [],
  },
]

test('an explicit model without a video variant is never replaced by another family', () => {
  const chosen: CatalogModel = {id:'chosen',name:'Выбранная',kind:'video',refs:false,params:[]}
  const catalog = [...models,chosen]
  assert.equal(effectiveModel(catalog,'video','chosen',false,true)?.id,'chosen')
  assert.equal(effectiveModel(catalog,'video','missing',false,true),null)
  assert.equal(effectiveModel(catalog,'video','seedance-2',false,true)?.id,'seedance-2-refs')
})

test('toBaseModelId maps ref variants to base', () => {
  assert.equal(toBaseModelId(models, 'seedance-2-i2v', 'video'), 'seedance-2')
  assert.equal(toBaseModelId(models, 'seedance-2-refs', 'video'), 'seedance-2')
  assert.equal(toBaseModelId(models, 'seedance-2', 'video'), 'seedance-2')
  assert.equal(toBaseModelId(models, 'nano-banana-edit', 'image'), 'nano-banana')
  assert.equal(toBaseModelId(models, 'ideogram-character-edit', 'image'), 'ideogram-character-edit')
})

test('resolveNodeModel upgrades by connected media like canvas', () => {
  assert.equal(resolveNodeModel(models, 'video', 'seedance-2', false, false)?.id, 'seedance-2')
  assert.equal(resolveNodeModel(models, 'video', 'seedance-2', true, false)?.id, 'seedance-2-i2v')
  assert.equal(resolveNodeModel(models, 'video', 'seedance-2', false, true)?.id, 'seedance-2-refs')
  // video wins over image
  assert.equal(resolveNodeModel(models, 'video', 'seedance-2', true, true)?.id, 'seedance-2-refs')
  assert.equal(resolveNodeModel(models, 'image', 'nano-banana', true, false)?.id, 'nano-banana-edit')
  assert.equal(resolveNodeModel(models, 'image', 'ideogram-character-edit', false, false)?.id, 'ideogram-character-edit')
})

test('новая нода берёт тот же глобальный дефолт, что и канвас', async () => {
  const module = await import('./nodeModel.js') as typeof import('./nodeModel.js') & {
    defaultNodeModelId?: (
      models: CatalogModel[],
      kind: string,
      defaults: { image: string | null; video: string | null; audio: string | null; assistant: string | null },
    ) => string | null
  }
  assert.equal(module.defaultNodeModelId?.(models, 'image', {
    image: 'ideogram-character-edit', video: null, audio: null, assistant: null,
  }), 'ideogram-character-edit')
})

test('canConnect: media port accepts image and video', () => {
  assert.equal(canConnect('image', 'media'), true)
  assert.equal(canConnect('video', 'media'), true)
  assert.equal(canConnect('text', 'media'), false)
  assert.equal(canConnect('image', 'video'), false)
  assert.equal(canConnect('video', 'video'), true)
})

test('canConnect: картинка НЕ подключается к текстовому входу', () => {
  // Разрешение писалось под vision, когда картинку в LLM было некуда подать,
  // кроме входа «контекст». Теперь у LLM свои картиночные порты, а под то же
  // правило попадал «промпт» генератора картинок: картинка втыкалась молча и
  // работала как референс, хотя порт называется иначе.
  assert.equal(canConnect('image', 'text'), false)
  assert.equal(canConnect('media', 'text'), false)
  assert.equal(canConnect('video', 'text'), false)
  assert.equal(canConnect('audio', 'text'), false)
  // а по своим портам всё соединяется как прежде
  assert.equal(canConnect('image', 'image'), true)
  assert.equal(canConnect('text', 'text'), true)
})

test('звуковые ноды: у каждой свои входы, и они типизированы', () => {
  // Группа «Аудио» (просьба пользователя 19.08.2026): модель звука, склейка
  // видео со звуком и извлечение дорожки. Порты обязаны быть разными — иначе
  // связь втыкается молча не туда, ради чего типы портов и заводились.
  assert.deepEqual(NODE_PORTS.muxAudio.inputs.map((p) => p.type), ['video', 'audio'])
  assert.deepEqual(NODE_PORTS.muxAudio.outputs.map((p) => p.type), ['video'])
  assert.deepEqual(NODE_PORTS.extractAudio.inputs.map((p) => p.type), ['video'])
  assert.deepEqual(NODE_PORTS.extractAudio.outputs.map((p) => p.type), ['audio'])
  assert.deepEqual(NODE_PORTS.audio.outputs.map((p) => p.type), ['audio'])
})

test('порядок портов у новых нод — общий: текст, картинка, видео, аудио', () => {
  // Разнобой в порядке сам по себе плодит пересечения проводов.
  const order = ['text', 'image', 'video', 'audio']
  for (const kind of ['audio', 'muxAudio', 'extractAudio'] as const) {
    const positions = NODE_PORTS[kind].inputs.map((p) => order.indexOf(p.type))
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `порядок входов у «${kind}»`)
  }
})

// Сторож «локальные операции со звуком не уходят в платную генерацию» переехал
// в server/src/macroEngine.test.ts: сам движок теперь там.

test('группа «Аудио» собрана в меню добавления', () => {
  const source = readFileSync(new URL('./NodesSpace.tsx', import.meta.url), 'utf8')
  for (const kind of ['audio', 'muxAudio', 'extractAudio']) {
    assert.match(source, new RegExp(`kind: '${kind}'[^}]*group: 'Audio'`))
  }
})

// ⚠️ Сторож на поломку 20.08.2026: в макросе пользователя осталась нода
// «Ответ» (kind: 'wait') от удалённых скриптов помощника, реестр её не знал,
// и обращение к NODE_PORTS[kind].outputs роняло ВЕСЬ редактор — макрос нельзя
// было открыть даже для того, чтобы её убрать.
test('нода неизвестного вида не роняет редактор', () => {
  const legacy = 'wait' as never
  assert.equal(isKnownNodeKind(legacy), false)
  assert.deepEqual(portsFor(legacy), { inputs: [], outputs: [] })
  assert.deepEqual(visibleOutputs(legacy), [])
  assert.equal(metaFor(legacy).title, 'Unknown node')
  // известные виды при этом отвечают как прежде
  assert.equal(isKnownNodeKind('image'), true)
  assert.ok(portsFor('image').outputs.length > 0)
  assert.equal(metaFor('image').title, 'Image')
})

// ⚠️ Реестры — обычные объекты, и на имя, доставшееся им от Object, отвечали
// «есть»: порты и подпись вида `constructor` оказывались функцией, вид считался
// знакомым, и редактор падал на такой ноде (`<meta.icon/>` с undefined,
// `...ports.inputs`). Такой вид приходил из файла обмена и из буфера.
test('вид ноды со служебным именем объекта — неизвестный, а не «знакомый»', () => {
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
    const kind = name as never
    assert.equal(isKnownNodeKind(kind), false, name)
    assert.deepEqual(portsFor(kind), { inputs: [], outputs: [] }, name)
    assert.deepEqual(visibleOutputs(kind), [], name)
    assert.equal(metaFor(kind).title, 'Unknown node', name)
    assert.equal(metaFor(kind).icon, metaFor('wait' as never).icon, name)
  }
  // вид не строкой (испорченный граф) — тоже неизвестный, без исключения
  for (const broken of [undefined, null, 7, {}]) assert.equal(isKnownNodeKind(broken as never), false)
})

test('нода неизвестного вида показывается предупреждением, а не пустотой', () => {
  const source = readFileSync(
    new URL('./GenNode.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /const unknownKind = !isKnownNodeKind\(data\.kind\)/)
  assert.match(source, /unknownKind && \(/)
  assert.equal(source.includes('NODE_PORTS[data.kind]'), false)
  assert.equal(source.includes('NODE_META[data.kind]'), false)
})
