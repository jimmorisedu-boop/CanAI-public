import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CanvasPasteArbiter, type PasteTimer } from './pasteArbiter.js'

function fakeTimer(): { timer: PasteTimer; fire: () => void } {
  let pending: (() => void) | null = null
  return {
    timer: {
      set(callback) {
        pending = callback
        return callback
      },
      clear(handle) {
        if (pending === handle) pending = null
      },
    },
    fire() {
      const callback = pending
      pending = null
      callback?.()
    },
  }
}

test('системное медиа отменяет ожидающую внутреннюю вставку', () => {
  const { timer, fire } = fakeTimer()
  const arbiter = new CanvasPasteArbiter(timer)
  let inserted = 0

  arbiter.schedule(() => { inserted += 1 })
  assert.equal(arbiter.settle(true), true)
  fire()

  assert.equal(inserted, 0)
})

test('без системного медиа внутренняя вставка выполняется ровно один раз', () => {
  const { timer, fire } = fakeTimer()
  const arbiter = new CanvasPasteArbiter(timer)
  let inserted = 0

  arbiter.schedule(() => { inserted += 1 })
  assert.equal(arbiter.settle(false), true)
  fire()

  assert.equal(inserted, 1)
})

test('таймер выполняет внутреннюю вставку, если событие paste не пришло', () => {
  const { timer, fire } = fakeTimer()
  const arbiter = new CanvasPasteArbiter(timer)
  let inserted = 0

  arbiter.schedule(() => { inserted += 1 })
  fire()

  assert.equal(inserted, 1)
  assert.equal(arbiter.settle(false), false)
})

test('Ctrl+V не отменяет системный paste до проверки скриншота из буфера', () => {
  const source = readFileSync(new URL('./useCanvasHotkeys.ts', import.meta.url), 'utf8')
  const pasteBranch = source.match(/else if \(isPaste\) \{([\s\S]*?)\n\s*\} else if \(isDuplicate\)/)?.[1]

  assert.ok(pasteBranch, 'ветка Ctrl+V должна существовать')
  assert.match(pasteBranch, /canvasPasteArbiter\.schedule/)
  assert.doesNotMatch(
    pasteBranch,
    /e\.preventDefault\(\)/,
    'keydown не должен подавлять следующее ClipboardEvent с системным изображением',
  )
})
