import assert from 'node:assert/strict'
import test from 'node:test'
import {
  argsCarryCookies,
  cookieArgsFor,
  isCookieMode,
  readExtractorCookies,
} from './extractorCookies.js'

test('без настройки вход не подмешивается вовсе', () => {
  assert.deepEqual(readExtractorCookies({}), { mode: 'none' })
  assert.deepEqual(cookieArgsFor({ mode: 'none' }), [])
  assert.equal(argsCarryCookies(['--no-playlist', 'https://vimeo.com/1']), false)
})

test('вход через окно приложения указывает путь к НАШЕМУ профилю', () => {
  const cookies = readExtractorCookies({ extractorCookiesMode: 'app' }, 'C:/CanAI/data/login-profile')
  assert.deepEqual(cookies, { mode: 'app', profileDir: 'C:/CanAI/data/login-profile' })
  // Firefox указывается профилем, а не именем: браузер человека мы не трогаем.
  assert.deepEqual(cookieArgsFor(cookies), ['--cookies-from-browser', 'firefox:C:/CanAI/data/login-profile'])
  assert(argsCarryCookies(cookieArgsFor(cookies)))
})

test('без известного профиля режим «app» превращается в «без входа»', () => {
  // Путь знает только сервер; не знаем его — честнее не подставлять ничего,
  // чем скормить extractor'у пустую строку.
  assert.deepEqual(readExtractorCookies({ extractorCookiesMode: 'app' }), { mode: 'none' })
})

test('файл cookies принимается и обрезается по краям', () => {
  const file = readExtractorCookies({ extractorCookiesMode: 'file', extractorCookiesFile: ' C:/keys/cookies.txt ' })
  assert.deepEqual(file, { mode: 'file', file: 'C:/keys/cookies.txt' })
  assert.deepEqual(cookieArgsFor(file), ['--cookies', 'C:/keys/cookies.txt'])
})

test('полузаполненный и битый выбор сводится к «без входа»', () => {
  assert.deepEqual(readExtractorCookies({ extractorCookiesMode: 'file', extractorCookiesFile: '   ' }), { mode: 'none' })
  // Перевод строки в пути — это чужая команда следом за нашей.
  assert.deepEqual(
    readExtractorCookies({ extractorCookiesMode: 'file', extractorCookiesFile: 'c.txt\n--exec evil' }),
    { mode: 'none' },
  )
  assert.deepEqual(readExtractorCookies({ extractorCookiesMode: 'что-то' }), { mode: 'none' })
})

test('способов входа ровно три, выбора «мой браузер» среди них нет', () => {
  // Chromium на Windows шифрует свои cookies, и такой выбор работал бы у
  // меньшинства, а выглядел бы рабочим у всех — см. шапку extractorCookies.ts.
  assert(isCookieMode('none'))
  assert(isCookieMode('app'))
  assert(isCookieMode('file'))
  assert.equal(isCookieMode('browser'), false)
})
