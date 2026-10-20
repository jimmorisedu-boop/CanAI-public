// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { withViewTransition } from './viewTransition.js'

// View Transitions отклоняет ready/finished, когда переход прерван: так бывает
// при быстром двойном переходе (галерея → доска → назад) и на скрытой вкладке.
// Без обработчиков это всплывало необработанным отказом промиса.

declare const globalThis: {
  document?: unknown
  process: { on(event: string, fn: (reason: unknown) => void): void; off(event: string, fn: (reason: unknown) => void): void }
}

function withFakeDocument<T>(startViewTransition: unknown, body: () => T): T {
  const previous = globalThis.document
  globalThis.document = { startViewTransition }
  try {
    return body()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

async function collectUnhandled(body: () => void): Promise<unknown[]> {
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown) => seen.push(reason)
  globalThis.process.on('unhandledRejection', onUnhandled)
  try {
    body()
    // отказ всплывает не раньше следующего оборота цикла событий
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    globalThis.process.off('unhandledRejection', onUnhandled)
  }
  return seen
}

test('без поддержки API обновление применяется сразу', () => {
  let applied = 0
  withFakeDocument(undefined, () => withViewTransition(() => { applied += 1 }))
  assert.equal(applied, 1)
})

test('прерванный переход не всплывает необработанным отказом', async () => {
  let applied = 0
  const aborted = () =>
    Promise.reject(
      Object.assign(new Error('Transition was aborted because of invalid state'), {
        name: 'InvalidStateError',
      }),
    )

  const seen = await collectUnhandled(() => {
    withFakeDocument(
      (callback: () => void) => {
        callback()
        return {
          ready: aborted(),
          finished: aborted(),
          updateCallbackDone: aborted(),
        }
      },
      () => withViewTransition(() => { applied += 1 }),
    )
  })

  assert.equal(applied, 1, 'экран обязан переключиться даже при прерванном переходе')
  assert.deepEqual(seen, [], 'отказы прерванного перехода должны быть обработаны')
})

test('обновление применяется РОВНО один раз — двойного перехода быть не должно', async () => {
  let applied = 0
  await collectUnhandled(() => {
    withFakeDocument(
      (callback: () => void) => {
        callback()
        return {
          ready: Promise.reject(new Error('прервано')),
          finished: Promise.resolve(),
          updateCallbackDone: Promise.resolve(),
        }
      },
      () => withViewTransition(() => { applied += 1 }),
    )
  })
  assert.equal(applied, 1)
})
