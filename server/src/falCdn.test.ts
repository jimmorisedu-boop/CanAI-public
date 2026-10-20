import test from 'node:test'
import assert from 'node:assert/strict'
import { downloadCandidates, falMirrorUrl, isNetworkError, withFalUploadMirror } from './falCdn.js'
import { FalRefUploadError, falErrorMessage } from './fal.js'

test('зеркало подставляется только для CDN fal и сохраняет путь', () => {
  assert.equal(
    falMirrorUrl('https://v3.fal.media/files/b/0aa/xyz_ref.png'),
    'https://v3b.fal.media/files/b/0aa/xyz_ref.png',
  )
  // и обратно: заблокировать может любой из двух
  assert.equal(
    falMirrorUrl('https://v3b.fal.media/files/b/0aa/xyz_ref.png'),
    'https://v3.fal.media/files/b/0aa/xyz_ref.png',
  )
})

test('чужим хостам зеркала не выдумываем', () => {
  assert.equal(falMirrorUrl('https://queue.fal.run/x'), null)
  assert.equal(falMirrorUrl('https://example.com/a.png'), null)
  assert.equal(falMirrorUrl('не-ссылка'), null)
})

test('запрос идёт по обоим адресам, начиная с исходного', () => {
  assert.deepEqual(downloadCandidates('https://v3.fal.media/f/a.png'), [
    'https://v3.fal.media/f/a.png',
    'https://v3b.fal.media/f/a.png',
  ])
  assert.deepEqual(downloadCandidates('https://example.com/a.png'), ['https://example.com/a.png'])
})

test('сетевая ошибка PUT в CDN повторяется через зеркало с тем же телом', async () => {
  const body = new Blob(['reference'])
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    assert.equal(init?.body, body)
    if (url.includes('v3.fal.media')) {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
    }
    return new Response(null, { status: 200 })
  }

  const response = await withFalUploadMirror(fetchImpl)(
    'https://v3.fal.media/files/upload/ref.png?token=secret',
    { method: 'PUT', body },
  )

  assert.equal(response.status, 200)
  assert.deepEqual(calls, [
    'https://v3.fal.media/files/upload/ref.png?token=secret',
    'https://v3b.fal.media/files/upload/ref.png?token=secret',
  ])
})

test('сетевой сбой отличаем от отказа сервера — повторять стоит только первый', () => {
  assert.equal(isNetworkError(new Error('fetch failed')), true)
  assert.equal(isNetworkError(new Error('socket hang up')), true)
  assert.equal(isNetworkError(new Error('terminated')), true)
  // именно этот код прилетал с заблокированного v3.fal.media
  assert.equal(isNetworkError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })), true)
  assert.equal(isNetworkError(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), true)

  assert.equal(isNetworkError(new Error('не удалось скачать результат (HTTP 404)')), false)
  assert.equal(isNetworkError(new Error('результат слишком большой')), false)
})

// Найдено живой проверкой каталога 2026-08-07. Обе беды выглядели одинаково:
// «Сеть до fal.ai оборвалась при загрузке». Но разница в деньгах прямая —
// референс не доехал ДО вызова модели (повтор бесплатен), а результат не
// скачался ПОСЛЕ (он уже оплачен, и повтор стоит вторую генерацию).
test('обрыв на отправке референса и на получении результата — разные сообщения', () => {
  const netError = Object.assign(new Error('fetch failed'), {
    cause: { code: 'ECONNRESET' },
  })

  const onUpload = falErrorMessage(new FalRefUploadError(netError))
  const onDownload = falErrorMessage(netError)

  assert.notEqual(onUpload, onDownload, 'по тексту должно быть видно, что сорвалось')
  assert.match(onUpload, /did not start|not charged/i, 'the reference was not charged')
  assert.match(onDownload, /already charged/i, 'the result was already charged')
})
