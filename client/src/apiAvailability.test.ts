// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { afterEach, test } from 'node:test'
import {
  api,
  ApiError,
  isLocalServiceUnavailable,
  LOCAL_SERVICE_UNAVAILABLE,
  LOCAL_SERVICE_UNAVAILABLE_MESSAGE,
} from './api'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

function installWindowTimers(
  setTimeoutImpl: (callback: TimerHandler) => unknown = globalThis.setTimeout,
): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout: setTimeoutImpl, clearTimeout: globalThis.clearTimeout },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

test('fetch rejection becomes a local-service error', async () => {
  installWindowTimers()
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }

  await assert.rejects(api.listProjects(), (error: unknown) => {
    assert.equal(isLocalServiceUnavailable(error), true)
    assert.equal((error as ApiError).code, LOCAL_SERVICE_UNAVAILABLE)
    assert.equal((error as Error).message, LOCAL_SERVICE_UNAVAILABLE_MESSAGE)
    return true
  })
})

test('empty local-gateway 500 becomes a local-service error', async () => {
  installWindowTimers()
  globalThis.fetch = async () => new Response(null, { status: 500 })

  await assert.rejects(api.listProjects(), (error: unknown) => {
    assert.equal(isLocalServiceUnavailable(error), true)
    assert.equal((error as ApiError).status, 500)
    return true
  })
})

test('JSON 500 from Express keeps its concrete error in English and preserves the original for diagnosis', async () => {
  installWindowTimers()
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'Не удалось прочитать индекс досок', code: 'PROJECT_INDEX_BROKEN' }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  )

  await assert.rejects(api.listProjects(), (error: unknown) => {
    assert.equal(isLocalServiceUnavailable(error), false)
    assert.equal((error as ApiError).message, 'Could not read the board index.')
    assert.equal((error as ApiError & { originalMessage: string }).originalMessage, 'Не удалось прочитать индекс досок')
    assert.equal((error as ApiError).code, 'PROJECT_INDEX_BROKEN')
    return true
  })
})

test('a successful status response localizes the stored error without translating user content', async () => {
  installWindowTimers()
  const payload = {
    enabled: true, state: 'error', error: 'Тип файла не поддерживается',
    title: 'Моя доска', snapshot: { text: 'Котики', error: 'Текст пользователя' },
  }
  globalThis.fetch = async () => Response.json(payload)
  const result = await api.job('fixture')
  assert.equal(result.error, 'This file type is not supported.')
  assert.deepEqual(result, { ...payload, error: 'This file type is not supported.' })
})

test('a Russian API rejection keeps HTTP status, code and structured details', async () => {
  installWindowTimers()
  const details = { supportedTypes: ['image/png'], fileName: 'котик.gif' }
  globalThis.fetch = async () => Response.json({
    error: 'Тип файла не поддерживается', code: 'UNSUPPORTED_MEDIA_TYPE', details,
  }, { status: 415 })
  await assert.rejects(api.listProjects(), (error: unknown) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.message, 'This file type is not supported.')
    assert.equal((error as ApiError & { originalMessage: string }).originalMessage, 'Тип файла не поддерживается')
    assert.equal(error.status, 415)
    assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE')
    assert.deepEqual(error.details, details)
    return true
  })
})

test('request timeout becomes a local-service error', async () => {
  installWindowTimers((callback: TimerHandler) => {
    queueMicrotask(() => typeof callback === 'function' && callback())
    return 1
  })
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })

  await assert.rejects(api.listProjects(), (error: unknown) => {
    assert.equal(isLocalServiceUnavailable(error), true)
    return true
  })
})

test('Показать в папке открывает локальный файл без запроса облачной копии', async () => {
  installWindowTimers()
  const calls: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json({ ok: true })
  }
  await api.revealFile('/media/local.png?v=12')
  assert.deepEqual(calls, [{ url: '/api/media/reveal', body: { src: '/media/local.png?v=12' } }])
})

test('local API has no Cloud, team, or personal publication operations', () => {
  assert.deepEqual(Object.keys(api).filter(name => /cloud|team|personalDraft/iu.test(name)), [])
  assert.equal(typeof api.listProjects, 'function')
  assert.equal(typeof api.generate, 'function')
})

test('legacy remote media cannot trigger a reveal request', async () => {
  installWindowTimers()
  let requests = 0
  globalThis.fetch = async () => { requests++; return Response.json({ ok: true }) }
  await assert.rejects(api.revealFile('/api/cloud-assets/assets/old-file'))
  await assert.rejects(api.revealFile('https://example.test/photo.png'))
  assert.equal(requests, 0)
})
