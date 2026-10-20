import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import type { PublicEditSession } from '../../api.js'
import {
  createExternalEditRegistry,
  type ExternalEditRegistryDependencies,
} from './externalEditRegistry.js'

function session(
  projectId = 'board-a',
  patch: Partial<PublicEditSession> = {},
): PublicEditSession {
  return {
    id: 'session-1',
    projectId,
    sourceItemId: 'source-1',
    sourceName: 'Фото',
    fileName: 'edit-session-1.png',
    url: '/media/edit-session-1.png',
    createdAt: 1,
    expiresAt: 999_999,
    lastMtime: 20,
    appliedMtime: 10,
    placedItemId: null,
    state: 'ready',
    projectName: 'Доска A',
    projectStatus: 'active',
    ...patch,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function fixture(initial: PublicEditSession[] = []) {
  let list = initial
  let listCalls = 0
  const acknowledgements: Array<{ id: string; appliedMtime: number; placedItemId: string }> = []
  const stopped: string[] = []
  const scheduled: Array<() => void> = []
  const deps: ExternalEditRegistryDependencies = {
    list: async () => {
      listCalls++
      return list
    },
    acknowledge: async (id, input) => {
      acknowledgements.push({ id, ...input })
      const current = list.find((item) => item.id === id) ?? initial.find((item) => item.id === id)
      if (!current) throw new Error('missing')
      return { ...current, ...input, state: 'applied' }
    },
    stop: async (id) => {
      stopped.push(id)
    },
    schedule: (callback) => {
      scheduled.push(callback)
      return callback
    },
    unschedule: (timer) => {
      const index = scheduled.indexOf(timer as () => void)
      if (index >= 0) scheduled.splice(index, 1)
    },
  }
  const registry = createExternalEditRegistry(deps)
  return {
    registry,
    acknowledgements,
    stopped,
    scheduled,
    setList(next: PublicEditSession[]) { list = next },
    listCalls: () => listCalls,
  }
}

test('паркует готовую правку до регистрации нужной доски', async () => {
  const f = fixture([session('board-a')])
  const deliveries: string[] = []
  await f.registry.load()
  assert.deepEqual(deliveries, [])
  f.registry.registerSink('board-b', async (item) => {
    deliveries.push(item.id)
    return { placedItemId: 'placed-b', message: 'ok' }
  })
  await tick()
  assert.deepEqual(deliveries, [])
  f.registry.registerSink('board-a', async (item) => {
    deliveries.push(item.id)
    return { placedItemId: 'placed-a', message: 'ok' }
  })
  await tick()
  assert.deepEqual(deliveries, ['session-1'])
})

test('много подписчиков используют один цикл опроса', async () => {
  const f = fixture([session()])
  const offA = f.registry.subscribe(() => {})
  const offB = f.registry.subscribe(() => {})
  await f.registry.load()
  assert.equal(f.scheduled.length, 1)
  const poll = f.scheduled.shift()!
  poll()
  await tick()
  assert.equal(f.listCalls(), 2)
  assert.equal(f.scheduled.length, 1)
  offA()
  offB()
})

test('не доставляет waiting, applied и broken', async () => {
  const states: PublicEditSession[] = [
    session('board-a', { id: 'waiting', state: 'waiting', lastMtime: 10, appliedMtime: 10 }),
    session('board-a', { id: 'applied', state: 'applied', appliedMtime: 20 }),
    session('board-a', { id: 'broken', state: 'broken', error: 'missing' }),
  ]
  const f = fixture(states)
  const deliveries: string[] = []
  f.registry.registerSink('board-a', async (item) => {
    deliveries.push(item.id)
    return { placedItemId: 'placed', message: 'ok' }
  })
  await f.registry.load()
  await tick()
  assert.deepEqual(deliveries, [])
})

test('одна версия сессии не доставляется параллельно дважды', async () => {
  const f = fixture([session()])
  const gate = deferred<{ placedItemId: string; message: string }>()
  let deliveries = 0
  f.registry.registerSink('board-a', async () => {
    deliveries++
    return gate.promise
  })
  await Promise.all([f.registry.load(true), f.registry.load(true)])
  await tick()
  assert.equal(deliveries, 1)
  gate.resolve({ placedItemId: 'placed', message: 'ok' })
  await tick()
})

test('поздний старый GET не перетирает более новый ответ', async () => {
  const oldRequest = deferred<PublicEditSession[]>()
  const newRequest = deferred<PublicEditSession[]>()
  let call = 0
  const deps: ExternalEditRegistryDependencies = {
    list: () => (++call === 1 ? oldRequest.promise : newRequest.promise),
    acknowledge: async () => { throw new Error('unused') },
    stop: async () => {},
    schedule: () => 1,
    unschedule: () => {},
  }
  const registry = createExternalEditRegistry(deps)
  const oldLoad = registry.load(true)
  const newLoad = registry.load(true)
  newRequest.resolve([session('board-a', { lastMtime: 30 })])
  await newLoad
  oldRequest.resolve([session('board-a', { lastMtime: 20 })])
  await oldLoad
  assert.equal(registry.getSnapshot().sessions[0].lastMtime, 30)
})

test('ошибка GET сохраняет прежние данные и оставляет повтор', async () => {
  const f = fixture([session()])
  await f.registry.load()
  f.setList([])
  const originalList = f.registry.getSnapshot().sessions
  const failure = new Error('нет связи')
  const retries: Array<() => void> = []
  const failing = createExternalEditRegistry({
    list: async () => { throw failure },
    acknowledge: async () => { throw new Error('unused') },
    stop: async () => {},
    schedule: (callback) => {
      retries.push(callback)
      return callback
    },
    unschedule: () => {},
  })
  failing.subscribe(() => {})
  failing.track(originalList[0])
  await assert.rejects(() => failing.load(true), /нет связи/)
  assert.equal(failing.getSnapshot().sessions.length, 1)
  assert.equal(failing.getSnapshot().status, 'error')
  assert.equal(retries.length, 1)
})

test('stop удаляет сессию из снимка только после успешного DELETE', async () => {
  const deletion = deferred<void>()
  const item = session()
  const registry = createExternalEditRegistry({
    list: async () => [item],
    acknowledge: async () => { throw new Error('unused') },
    stop: () => deletion.promise,
    schedule: () => 1,
    unschedule: () => {},
  })
  await registry.load()
  const stopping = registry.stop(item.id)
  assert.equal(registry.getSnapshot().sessions.length, 1)
  deletion.resolve()
  await stopping
  assert.equal(registry.getSnapshot().sessions.length, 0)
})

test('без sink активная сессия продолжает опрашиваться', async () => {
  const f = fixture([session()])
  await f.registry.load()
  assert.equal(f.scheduled.length, 1)
})

test('ack вызывается только после завершения sink', async () => {
  const f = fixture([session()])
  const gate = deferred<{ placedItemId: string; message: string }>()
  f.registry.registerSink('board-a', () => gate.promise)
  await f.registry.load()
  await tick()
  assert.equal(f.acknowledgements.length, 0)
  gate.resolve({ placedItemId: 'placed', message: 'applied' })
  await tick()
  assert.deepEqual(f.acknowledgements, [{
    id: 'session-1', appliedMtime: 20, placedItemId: 'placed',
  }])
})

test('ошибка sink оставляет версию ready для следующей попытки', async () => {
  const f = fixture([session()])
  let attempts = 0
  const off = f.registry.registerSink('board-a', async () => {
    attempts++
    if (attempts === 1) throw new Error('save failed')
    return { placedItemId: 'placed', message: 'ok' }
  })
  await f.registry.load()
  await tick()
  assert.equal(f.registry.getSnapshot().sessions[0].state, 'ready')
  off()
  f.registry.registerSink('board-a', async () => {
    attempts++
    return { placedItemId: 'placed', message: 'ok' }
  })
  await tick()
  assert.equal(attempts, 2)
})

test('рестарт после сохранения, но до ack повторяет подтверждение без вечного ready', async () => {
  const item = session()
  let deliveries = 0
  let acknowledgements = 0
  const registry = createExternalEditRegistry({
    list: async () => [item],
    acknowledge: async (_id, input) => {
      acknowledgements++
      if (acknowledgements === 1) throw new Error('server restarted before ack')
      return { ...item, ...input, state: 'applied' }
    },
    stop: async () => {},
    schedule: () => 1,
    unschedule: () => {},
  })
  registry.registerSink('board-a', async () => {
    deliveries++
    return { placedItemId: 'placed', message: 'saved' }
  })
  await registry.load()
  await tick()
  assert.equal(deliveries, 1)
  assert.equal(registry.getSnapshot().sessions[0].state, 'ready')
  await registry.load(true)
  await tick()
  assert.equal(deliveries, 2)
  assert.equal(acknowledgements, 2)
  assert.equal(registry.getSnapshot().sessions[0].state, 'applied')
})

test('реестр не использует браузерное хранилище', async () => {
  const source = await fs.readFile(new URL('./externalEditRegistry.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/)
})
