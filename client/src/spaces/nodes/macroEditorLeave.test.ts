// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { createMacroEditorLeaveController } from './macroEditorLeave.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('выход до debounce ждёт finalize и только потом размонтирует редактор', async () => {
  const pendingSave = deferred()
  const events: string[] = []
  const controller = createMacroEditorLeaveController()
  controller.register(async () => {
    events.push('finalize')
    await pendingSave.promise
    events.push('saved')
  })

  const leaving = controller.leave(() => {
    events.push('left')
  })

  assert.deepEqual(events, ['finalize'])
  pendingSave.resolve()
  assert.equal(await leaving, true)
  assert.deepEqual(events, ['finalize', 'saved', 'left'])
})

test('ошибка finalize оставляет редактор открытым', async () => {
  let left = false
  const controller = createMacroEditorLeaveController()
  controller.register(async () => {
    throw new Error('не сохранилось')
  })

  const result = await controller.leave(() => {
    left = true
  })

  assert.equal(result, false)
  assert.equal(left, false)
})

test('явный отказ от правок обходит finalize', async () => {
  let finalized = 0
  let left = false
  const controller = createMacroEditorLeaveController()
  controller.register(async () => {
    finalized++
    throw new Error('не должен вызываться')
  })

  const result = await controller.leave(
    () => {
      left = true
    },
    { discard: true },
  )

  assert.equal(result, true)
  assert.equal(finalized, 0)
  assert.equal(left, true)
})

test('повторный переход во время finalize выполняет только последнее намерение', async () => {
  const pendingSave = deferred()
  const destinations: string[] = []
  const controller = createMacroEditorLeaveController()
  controller.register(async () => {
    await pendingSave.promise
  })

  const toCanvas = controller.leave(() => {
    destinations.push('canvas')
  })
  const toGallery = controller.leave(() => {
    destinations.push('gallery')
  })

  pendingSave.resolve()
  assert.equal(await toCanvas, true)
  assert.equal(await toGallery, true)
  assert.deepEqual(destinations, ['gallery'])
})
