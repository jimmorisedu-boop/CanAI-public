import assert from 'node:assert/strict'
import test from 'node:test'
import { firefoxProxyPrefs } from './loginBrowserProxy.js'

test('прокси приложения переносится в профиль окна входа', () => {
  const prefs = firefoxProxyPrefs('http://127.0.0.1:10808')
  assert(prefs)
  assert.match(prefs, /network\.proxy\.type", 1/)
  assert.match(prefs, /network\.proxy\.http", "127\.0\.0\.1"/)
  assert.match(prefs, /network\.proxy\.http_port", 10808/)
  // ⚠️ HTTPS отдельной парой ключей: без неё весь вход (а он целиком https)
  // пошёл бы мимо прокси, и окно снова упёрлось бы в «время истекло».
  assert.match(prefs, /network\.proxy\.ssl", "127\.0\.0\.1"/)
  assert.match(prefs, /network\.proxy\.ssl_port", 10808/)
  // Свой сервер — мимо прокси: туда он не нужен и только мешает.
  assert.match(prefs, /no_proxies_on", "localhost, 127\.0\.0\.1"/)
})

test('без прокси ничего не пишем — системную настройку человека не отнимаем', () => {
  // Firefox по умолчанию уважает системный прокси и VPN-клиент; выставить
  // «ходить напрямую» значило бы оборвать их молча.
  assert.equal(firefoxProxyPrefs(null), null)
  assert.equal(firefoxProxyPrefs(undefined), null)
  assert.equal(firefoxProxyPrefs(''), null)
})

test('мусор и неподдержанные схемы не превращаются в настройку', () => {
  assert.equal(firefoxProxyPrefs('вообще не адрес'), null)
  // SOCKS приложение не поддерживает намеренно (см. cloudRoute) — молча
  // подставлять его как http значило бы обещать связь, которой не будет.
  assert.equal(firefoxProxyPrefs('socks5://127.0.0.1:1080'), null)
  assert.equal(firefoxProxyPrefs('http://:10808'), null)
})

test('порт по умолчанию берётся из схемы, а не теряется', () => {
  assert.match(firefoxProxyPrefs('http://proxy.local') ?? '', /http_port", 80/)
  assert.match(firefoxProxyPrefs('https://proxy.local') ?? '', /ssl_port", 443/)
})

test('логин и пароль в профиль не попадают', () => {
  // Firefox их из файла настроек не прочитает — спросит окном; а класть
  // секреты в профиль на диске незачем.
  const prefs = firefoxProxyPrefs('http://alice:secret@127.0.0.1:10808') ?? ''
  assert.equal(prefs.includes('secret'), false)
  assert.equal(prefs.includes('alice'), false)
  assert.match(prefs, /http_port", 10808/)
})
