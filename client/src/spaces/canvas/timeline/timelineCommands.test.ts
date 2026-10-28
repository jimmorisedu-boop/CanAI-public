import assert from 'node:assert/strict'
import test from 'node:test'
import { runTimelineCommand, seekDelta, type TimelineCommandEnv } from './timelineCommands'

function env(over: Partial<TimelineCommandEnv> = {}): { env: TimelineCommandEnv; calls: string[]; head: () => number } {
  const calls: string[] = []
  let head = over.head ?? 5
  const log = (name: string) => (...args: unknown[]) => { calls.push(args.length ? `${name}:${args.join(',')}` : name) }
  const result: TimelineCommandEnv = {
    head,
    inPoint: 1,
    outPoint: 9,
    cuts: [3.5, 6.5],
    duration: 10,
    frameStep: 0.04,
    targetIsButton: false,
    prevent: log('prevent'),
    close: log('close'),
    apply: log('apply'),
    togglePlay: log('play'),
    pause: log('pause'),
    setHead: (time) => { head = time; calls.push(`head:${time}`) },
    cut: log('cut'),
    toggleDrop: log('drop'),
    trimLeft: log('trimLeft'),
    trimRight: log('trimRight'),
    markIn: log('in'),
    markOut: log('out'),
    capture: log('capture'),
    crop: log('crop'),
    audio: log('audio'),
    toggleShelf: log('shelf'),
    fit: log('fit'),
    showFrame: log('show'),
    downloadFrame: log('download'),
    ...over,
  }
  return { env: result, calls, head: () => head }
}

test('стрелка — ровно кадр, с Shift — 10 кадров, PageUp — десятая клипа', () => {
  const base = { duration: 10, frameStep: 0.04 }
  assert.equal(seekDelta({ kind: 'seek', direction: 1, tenFrames: false }, base), 0.04)
  assert.ok(Math.abs(seekDelta({ kind: 'seek', direction: -1, tenFrames: true }, base) - -0.4) < 1e-9)
  assert.equal(seekDelta({ kind: 'seek', direction: 1, tenFrames: false, page: true }, base), 1)
  // у очень короткого клипа страница не меньше десятой секунды
  assert.equal(seekDelta({ kind: 'seek', direction: 1, tenFrames: false, page: true }, { duration: 0.5, frameStep: 0.04 }), 0.1)
})

test('перемотка ставит видео на паузу и двигает голову, края — к входу и выходу', () => {
  const step = env()
  runTimelineCommand({ kind: 'seek', direction: -1, tenFrames: true }, step.env)
  assert.deepEqual(step.calls, ['prevent', 'pause', 'head:4.6'])
  const edge = env()
  runTimelineCommand({ kind: 'seek', direction: -1, tenFrames: false, edge: 'start' }, edge.env)
  assert.equal(edge.head(), 1)
  runTimelineCommand({ kind: 'seek', direction: 1, tenFrames: false, edge: 'end' }, edge.env)
  assert.equal(edge.head(), 9)
})

test('переход по склейкам (↑ к следующей, ↓ к предыдущей) ставит паузу и идёт по точкам монтажа', () => {
  const jump = env({ head: 2, inPoint: 1, outPoint: 9, cuts: [3.5, 6.5] })
  runTimelineCommand({ kind: 'jumpCut', direction: 1 }, jump.env)
  assert.deepEqual(jump.calls, ['prevent', 'pause', 'head:3.5'])

  const back = env({ head: 6.5, inPoint: 1, outPoint: 9, cuts: [3.5, 6.5] })
  runTimelineCommand({ kind: 'jumpCut', direction: -1 }, back.env)
  assert.deepEqual(back.calls, ['prevent', 'pause', 'head:3.5'])
})

test('Enter на сфокусированной кнопке не применяет второй раз — кнопка нажмётся сама', () => {
  const onButton = env({ targetIsButton: true })
  runTimelineCommand({ kind: 'apply' }, onButton.env)
  assert.deepEqual(onButton.calls, [])
  const elsewhere = env()
  runTimelineCommand({ kind: 'apply' }, elsewhere.env)
  assert.deepEqual(elsewhere.calls, ['prevent', 'apply'])
})

test('вход и выход ставятся ровно в позицию головы', () => {
  const run = env({ head: 3.2 })
  runTimelineCommand({ kind: 'in' }, run.env)
  runTimelineCommand({ kind: 'out' }, run.env)
  assert.deepEqual(run.calls, ['prevent', 'in:3.2', 'prevent', 'out:3.2'])
})

test('каждая буквенная команда доходит до своего действия', () => {
  const table: Array<[Parameters<typeof runTimelineCommand>[0], string]> = [
    [{ kind: 'cut' }, 'cut'],
    [{ kind: 'toggleDrop' }, 'drop'],
    [{ kind: 'trimLeft' }, 'trimLeft'],
    [{ kind: 'trimRight' }, 'trimRight'],
    [{ kind: 'capture' }, 'capture'],
    [{ kind: 'crop' }, 'crop'],
    [{ kind: 'audio' }, 'audio'],
    [{ kind: 'drawer' }, 'shelf'],
    [{ kind: 'fit' }, 'fit'],
    [{ kind: 'showOnCanvas' }, 'show'],
    [{ kind: 'downloadFrame' }, 'download'],
    [{ kind: 'play' }, 'play'],
    [{ kind: 'close' }, 'close'],
  ]
  for (const [command, action] of table) {
    const run = env()
    runTimelineCommand(command, run.env)
    assert.deepEqual(run.calls, ['prevent', action], `команда ${command.kind}`)
  }
})
