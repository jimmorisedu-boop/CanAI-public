// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { api, ApiError } from './api'

test('uploadFile отвергает файл больше 2 GiB до открытия соединения', async () => {
  const originalXhr = globalThis.XMLHttpRequest
  let opened = 0
  class FakeXmlHttpRequest {
    upload = {}
    status = 201
    responseText = JSON.stringify({ url: '/media/file.mp4', mime: 'video/mp4' })
    onload: (() => void) | null = null
    open() { opened++ }
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onload?.()) }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: FakeXmlHttpRequest })
  const file = new File(['video'], 'large.mp4', { type: 'video/mp4' })
  Object.defineProperty(file, 'size', { value: 2 * 1024 * 1024 * 1024 + 1 })
  try {
    await assert.rejects(api.uploadFile(file), (error: unknown) => error instanceof ApiError && error.status === 413 && /2 GiB/.test(error.originalMessage))
    assert.equal(opened, 0)
  } finally {
    Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: originalXhr })
  }
})

test('uploadFile превращает не-JSON ответ шлюза в управляемую ошибку', async () => {
  const originalXhr = globalThis.XMLHttpRequest

  class FakeXmlHttpRequest {
    status = 502
    responseText = '<html>gateway down</html>'
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    onload: (() => void) | null = null

    open(): void {}
    setRequestHeader(): void {}
    abort(): void { this.onabort?.() }
    send(): void {
      queueMicrotask(() => {
        // Браузер сообщает исключение из обработчика события отдельно: оно не
        // отклоняет Promise, который uploadFile вернул вызывающему коду.
        try {
          this.onload?.()
        } catch {
          // Имитируем изоляцию исключения диспетчером DOM-событий.
        }
      })
    }
  }

  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    value: FakeXmlHttpRequest,
  })

  try {
    const outcome = await Promise.race([
      api.uploadFile(new File(['broken'], 'broken.png', { type: 'image/png' }))
        .then(() => 'resolved' as const, (error: unknown) => error),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ])

    assert.notEqual(outcome, 'pending', 'Promise загрузки остался незавершённым')
    assert.ok(outcome instanceof ApiError)
    assert.match(outcome.message, /HTTP 502/)
  } finally {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      value: originalXhr,
    })
  }
})

test('uploadFile не начинает запрос с уже отменённым signal', async () => {
  const originalXhr = globalThis.XMLHttpRequest
  let sendCalls = 0

  class FakeXmlHttpRequest {
    status = 201
    responseText = JSON.stringify({ url: '/media/uploaded.png', mime: 'image/png' })
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    onload: (() => void) | null = null

    open(): void {}
    setRequestHeader(): void {}
    abort(): void { this.onabort?.() }
    send(): void {
      sendCalls += 1
      queueMicrotask(() => this.onload?.())
    }
  }

  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    value: FakeXmlHttpRequest,
  })

  try {
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      api.uploadFile(new File(['cancelled'], 'cancelled.png', { type: 'image/png' }), controller.signal),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    )
    assert.equal(sendCalls, 0, 'Отменённая до старта загрузка не должна отправлять файл')
  } finally {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      value: originalXhr,
    })
  }
})
