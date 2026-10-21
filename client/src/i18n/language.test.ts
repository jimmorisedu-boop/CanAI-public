import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LOCALE,
  getIntlLocale,
  LANGUAGE_STORAGE_KEY,
  createLanguageStore,
  readStoredLocale,
  resolveLanguageStorage,
} from './language.js'
import { translateForLocale } from './translate.js'
import { ru } from './ru.js'

function placeholderIds(value: string): string[] {
  return [...value.matchAll(/\{(\d+)\}/gu)].map((match) => match[1]).sort()
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem(key: string) { return values.get(key) ?? null },
    setItem(key: string, value: string) { values.set(key, value) },
  }
}

test('language defaults to English and accepts only the persisted enum', () => {
  assert.equal(readStoredLocale(memoryStorage()), DEFAULT_LOCALE)
  assert.equal(readStoredLocale(memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'ru' })), 'ru')
  assert.equal(readStoredLocale(memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'de' })), 'en')
  assert.equal(readStoredLocale(memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'ru-RU' })), 'en')
})

test('language maps to stable browser Intl locale tags', () => {
  assert.equal(getIntlLocale('en'), 'en-US')
  assert.equal(getIntlLocale('ru'), 'ru-RU')
})

test('switching persists and notifies once; storage failures stay in memory', () => {
  const storage = memoryStorage()
  const store = createLanguageStore(storage)
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications += 1 })

  store.set('ru')
  assert.equal(store.getSnapshot(), 'ru')
  assert.equal(storage.values.get(LANGUAGE_STORAGE_KEY), 'ru')
  assert.equal(notifications, 1)
  store.set('ru')
  assert.equal(notifications, 1)
  unsubscribe()

  const blocked = createLanguageStore({
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
  })
  blocked.set('ru')
  assert.equal(blocked.getSnapshot(), 'ru')
})

test('storage access resolution is safe when the browser throws', () => {
  assert.equal(resolveLanguageStorage(undefined), null)
  assert.equal(resolveLanguageStorage({
    get localStorage(): never { throw new Error('blocked') },
  }), null)
})

test('interpolation replaces only supplied positional params and leaves values intact', () => {
  const name = 'Board {0} / русское имя'
  assert.equal(
    translateForLocale('en', 'Open board “{0}”', { 0: name }),
    `Open board “${name}”`,
  )
  assert.equal(
    translateForLocale('en', 'Keep {0} and {1}', { 0: 'x' }),
    'Keep x and {1}',
  )
})

test('prototype names never resolve to inherited catalogue values', () => {
  assert.equal(translateForLocale('ru', 'constructor'), 'constructor')
  assert.equal(translateForLocale('ru', '__proto__'), '__proto__')
})

test('Russian catalogue preserves every English positional placeholder exactly', () => {
  for (const [key, value] of Object.entries(ru)) {
    assert.deepEqual(
      placeholderIds(value),
      placeholderIds(key),
      `placeholder mismatch for ${JSON.stringify(key)}`,
    )
  }
})
