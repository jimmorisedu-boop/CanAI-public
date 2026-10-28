// @ts-nocheck — production hook runs against small injected React/API ports, without a DOM or media encoder.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import * as model from './timelineModel'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const code = ts.transpileModule(fs.readFileSync(new URL('./useTimelineSession.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

async function fixture(src = '/media/source.mp4') {
  const video = { id: 'source', kind: 'video', src, name: 'source.mp4', x: 0, y: 0, w: 360, h: 640 }
  const frames = Array.from({ length: 6 }, (_, index) => ({ id: `frame-${index}`, kind: 'image', src: `/media/frame-${index}.png` }))
  const items = [video, ...frames]
  const slots = []
  let cursor = 0
  let effects = []
  let target = video.id
  let onTarget = () => {}
  const calls = { cut: 0, adopt: 0, place: 0, notices: [] }
  const store = {
    getItem: id => items.find(item => item.id === id),
    placeVideoPieces: (_source, pieces) => {
      calls.place++
      const created = pieces.map((piece, index) => ({ ...video, id: `edited-${index}`, src: piece.url }))
      items.push(...created)
      return created.map(item => item.id)
    },
    removeItems: () => {},
  }
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
  }
  const modules = {
    react,
    '../../../api': { api: {
      probeVideo: async () => ({ duration: 8, fps: 25, width: 360, height: 640, hasAudio: false }),
      cutVideo: async (_src, kept) => {
        calls.cut++
        return { pieces: kept.map((piece, index) => ({ ...piece, url: `/media/edited-${index}.mp4` })) }
      },
    } },
    './timelineNotice': { notifyInTimeline: notice => calls.notices.push(notice) },
    '../konva/boardUploader': { adoptForBoard: async piece => { calls.adopt++; return piece } },
    '../konva/useStore': { useContentVersion: () => {} },
    './timelineModel': model,
    './timelineLeaveGuard': { registerTimelineLeaveGuard: () => () => {}, requestTimelineLeave: async () => true },
    './timelineBus': {
      getTimelineTarget: () => target,
      onTimelineTarget: fn => { onTarget = fn; return () => {} },
      setTimelineTarget: value => { target = value; onTarget(value) },
    },
    '../../../i18n/context.js': { useT: () => message => message },
  }
  const exports = {}
  vm.runInNewContext(`(function(require, exports) { ${code}\n })`, { console })(
    name => { assert.ok(name in modules, `Unexpected production import: ${name}`); return modules[name] }, exports,
  )
  const render = () => { cursor = 0; effects = []; return exports.useTimelineSession(store) }
  render()
  for (const effect of effects) effect()
  await Promise.resolve()
  await Promise.resolve()
  return { render, items, video, frames, calls, target: () => target }
}

for (const [board, src] of [['local', '/media/source.mp4']]) {
  test(`${board}: подтверждение после сохранения шести кадров закрывает просмотрщик без копии видео`, async () => {
    const f = await fixture(src)
    const before = [...f.items]
    assert.equal(await f.render().apply(), 'applied', 'successful confirmation also closes the tablet editor')
    assert.equal(f.target(), null)
    assert.equal(f.calls.cut, 0, 'unchanged video must never reach the encoder')
    assert.equal(f.calls.adopt, 0, 'unchanged video must not duplicate local media')
    assert.equal(f.calls.place, 0)
    assert.deepEqual(f.items, before, 'original video and all captured frames stay unchanged')
    assert.equal(f.calls.notices.length, 0, 'no misleading transcoding message')
  })
}

test('перемотка и отменённые правки не превращаются в экспорт', async () => {
  const f = await fixture()
  f.render().setHead(4)
  f.render().addCut()
  f.render().removeCut(4)
  f.render().moveIn(1)
  f.render().moveIn(0)
  f.render().moveOut(7)
  f.render().moveOut(8)
  f.render().toggleCrop()
  f.render().toggleCrop()
  await f.render().apply()
  assert.equal(f.target(), null)
  assert.equal(f.calls.cut, 0)
  assert.equal(f.items.length, 7)
})

test('кадрирование на весь исходный кадр также не создаёт копию', async () => {
  const f = await fixture()
  f.render().setCrop({ x: 0, y: 0, w: 1, h: 1 })
  await f.render().apply()
  assert.equal(f.calls.cut, 0)
  assert.equal(f.items.length, 7)
})

for (const edit of ['trim', 'cut', 'crop', 'drop']) {
  test(`${edit}: настоящие изменения по-прежнему создают новые клипы`, async () => {
    const f = await fixture()
    if (edit === 'trim') f.render().moveIn(1)
    if (edit === 'crop') f.render().toggleCrop()
    if (edit === 'cut' || edit === 'drop') {
      f.render().setHead(4)
      f.render().addCut()
      if (edit === 'drop') f.render().toggleDropAtHead()
    }
    assert.equal(await f.render().apply(), 'applied')
    assert.equal(f.calls.cut, 1)
    assert.equal(f.calls.place, 1)
    const pieces = edit === 'cut' ? 2 : 1
    assert.equal(f.calls.adopt, pieces)
    assert.equal(f.items.length, 7 + pieces)
    assert.equal(f.items[0], f.video)
    assert.deepEqual(f.items.slice(1, 7), f.frames)
  })
}

test('trimLeftAtHead (Q) и trimRightAtHead (W) подрезают текущий кусок на границе и внутри нарезки', async () => {
  // На едином клипе 0..8: Q на 1.5с двигает inPoint в 1.5, W на 6.5с двигает outPoint в 6.5
  const outer = await fixture()
  outer.render().setHead(1.5)
  outer.render().trimLeftAtHead()
  assert.equal(outer.render().inPoint, 1.5)
  outer.render().setHead(6.5)
  outer.render().trimRightAtHead()
  assert.equal(outer.render().outPoint, 6.5)
  assert.equal(await outer.render().apply(), 'applied')
  assert.equal(outer.calls.adopt, 1)

  // На разрезанном клипе [0..3, 3..8]: Q на 4.5с отрезает [3..4.5] и оставляет два живых куска [0..3] и [4.5..8]
  const inner = await fixture()
  inner.render().setHead(3)
  inner.render().addCut()
  inner.render().setHead(4.5)
  inner.render().trimLeftAtHead()
  assert.equal(inner.render().pieces, 2)
  assert.deepEqual(
    model.keptSegments(inner.render().segments, inner.render().dropped),
    [{ start: 0, end: 3 }, { start: 4.5, end: 8 }],
  )
})

test('toggleDropAt убирает и возвращает произвольный кусок по его началу, защищая последний живой', async () => {
  const f = await fixture()
  f.render().setHead(4)
  f.render().addCut()
  // С курсором на 4с отключаем ПЕРВЫЙ кусок (start = 0) напрямую с дорожки
  f.render().toggleDropAt(0)
  assert.deepEqual([...f.render().dropped], [0])
  // Попытка отключить последний оставшийся кусок (start = 4) блокируется с подсказкой
  f.render().toggleDropAt(4)
  assert.deepEqual([...f.render().dropped], [0])
  assert.ok(f.calls.notices.length >= 1)
  // Повторный вызов возвращает первый кусок обратно
  f.render().toggleDropAt(0)
  assert.deepEqual([...f.render().dropped], [])
})
