import assert from 'node:assert/strict'
import test from 'node:test'
import { systemErrorMessage, systemMessage, systemStatusMessage, SYSTEM_ERROR_FALLBACK } from './systemMessage'

test('known legacy server errors keep a concrete English explanation', () => {
  assert.equal(systemMessage('Тип файла не поддерживается'), 'This file type is not supported.')
  assert.equal(systemMessage('  ТИП ФАЙЛА НЕ ПОДДЕРЖИВАЕТСЯ.  '), 'This file type is not supported.')
  assert.equal(systemMessage('Диалог не найден'), 'Chat not found.')
  assert.equal(systemMessage('Не удалось загрузить описание модели'), 'Could not load the model description.')
  assert.equal(systemMessage('Файл проекта повреждён'), 'The project file is corrupted.')
  assert.equal(systemMessage('Сервер команды сбросил вход.'), 'The team server reset your sign-in.')
  assert.equal(systemMessage('отменено'), 'Cancelled')
})

test('English context is retained around a legacy server error', () => {
  assert.equal(systemMessage('Upload failed: Тип файла не поддерживается'), 'Upload failed: This file type is not supported.')
})

test('structured codes preserve a useful action for unrecognized legacy messages', () => {
  assert.equal(systemMessage('Vimeo отдаёт видео только после входа в аккаунт', undefined, 'MEDIA_LINK_LOGIN_REQUIRED'),
    'Sign in to the source website to download this file.')
})

test('unknown Russian system errors use an English fallback rather than leaking into the interface', () => {
  assert.equal(systemMessage('Новый текст ошибки старого сервера'), SYSTEM_ERROR_FALLBACK)
  assert.equal(systemMessage('Новый текст ошибки', 'Could not export the board.'), 'Could not export the board.')
  assert.equal(systemMessage(undefined, 'Could not export the board.'), 'Could not export the board.')
})

test('English errors and quoted user names retain their original text', () => {
  for (const message of [
    'HTTP 429: rate limit exceeded',
    'constructor',
    '__proto__',
    'Board "Моя доска" is read-only',
    'Could not upload «котик.png»',
    'Could not open “Педро”',
  ]) assert.equal(systemMessage(message), message)
})

test('quoted provider failures and serialized errors cannot bypass English presentation', () => {
  assert.equal(systemMessage('Provider returned "Неизвестная ошибка"'), SYSTEM_ERROR_FALLBACK)
  assert.equal(systemMessage('{"error":"Ошибка сервера"}'), SYSTEM_ERROR_FALLBACK)
  assert.equal(systemMessage('Provider returned: "Ошибка сервера"'), `Provider returned: ${SYSTEM_ERROR_FALLBACK}`)
})

test('typed error fields accept persisted strings without mutating the raw value', () => {
  const persisted = { error: 'Нет связи', code: 'NETWORK', retryable: true }
  assert.equal(systemErrorMessage(persisted.error), 'Connection lost.')
  assert.deepEqual(persisted, { error: 'Нет связи', code: 'NETWORK', retryable: true })
})

test('progress fields use a neutral English stage while preserving unknown raw text', () => {
  assert.equal(systemStatusMessage('загрузка'), 'Uploading…')
  assert.equal(systemStatusMessage('ожидание'), 'Waiting…')
  assert.equal(systemStatusMessage('Неизвестная стадия'), 'Working…')
  assert.equal(systemStatusMessage('Uploading…'), 'Uploading…')
  assert.equal(systemStatusMessage('constructor'), 'constructor')
  assert.equal(systemStatusMessage('__proto__'), '__proto__')
})
