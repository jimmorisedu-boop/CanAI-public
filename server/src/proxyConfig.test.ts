import assert from 'node:assert/strict'
import test from 'node:test'
import { isLocalHost, noProxyMatches, proxyForUrl } from './proxyConfig.js'

const env = { HTTPS_PROXY: 'http://127.0.0.1:10809', HTTP_PROXY: 'http://127.0.0.1:10808' }

test('сервер команды идёт через прокси и для запросов, и для сокета', () => {
  assert.equal(proxyForUrl('https://canai.example.com/v3/me', env), 'http://127.0.0.1:10809/')
  assert.equal(proxyForUrl('wss://canai.example.com/v3/boards/socket', env), 'http://127.0.0.1:10809/')
})

test('свои адреса через прокси не ходят НИКОГДА', () => {
  // ⚠️ Планшетная и гостевая страницы живут на этой же машине и в локальной
  // сети: увести их наружу значит сломать их вместе с прокси.
  for (const target of [
    'http://127.0.0.1:8787/api/status',
    'http://localhost:8788/',
    'ws://192.168.0.20:8789/socket',
    'http://10.0.0.5/',
    'http://[::1]:8787/',
  ]) assert.equal(proxyForUrl(target, env), null, target)
  assert.equal(isLocalHost('172.16.4.4'), true)
  assert.equal(isLocalHost('8.8.8.8'), false)
})

test('http и https берут СВОИ переменные и не подменяют друг друга', () => {
  // У обычного прокси-клиента это разные порты и часто разные протоколы:
  // подстановка «похожего» адреса выглядела бы рабочей, а рвала бы соединение.
  assert.equal(proxyForUrl('http://canai.example.com/', env), 'http://127.0.0.1:10808/')
  assert.equal(proxyForUrl('https://canai.example.com/', { HTTP_PROXY: env.HTTP_PROXY }), null)
})

test('NO_PROXY уважается по имени, суффиксу и звёздочке', () => {
  const withRule = (rule: string) => proxyForUrl('https://canai.example.com/', { ...env, NO_PROXY: rule })
  assert.equal(withRule('canai.example.com'), null)
  assert.equal(withRule('.example.com'), null)
  assert.equal(withRule('*.example.com'), null)
  assert.equal(withRule('*'), null)
  assert.equal(withRule('other.com'), 'http://127.0.0.1:10809/')
  assert.equal(noProxyMatches('canai.example.com:443', 'canai.example.com'), true)
})

test('SOCKS не выдаём за рабочий прокси', () => {
  // Туннель CONNECT умеет только HTTP-прокси. Принять socks5 значило бы
  // молча оборвать соединение там, где человек считает настройку рабочей.
  assert.equal(proxyForUrl('https://canai.example.com/', { HTTPS_PROXY: 'socks5://127.0.0.1:10808' }), null)
})

test('адрес без схемы понимается как http, мусор — не понимается', () => {
  assert.equal(proxyForUrl('https://canai.example.com/', { HTTPS_PROXY: '127.0.0.1:10809' }), 'http://127.0.0.1:10809/')
  assert.equal(proxyForUrl('https://canai.example.com/', { HTTPS_PROXY: ':::' }), null)
  assert.equal(proxyForUrl('не ссылка', env), null)
})

test('без настроек прокси ничего не меняется', () => {
  assert.equal(proxyForUrl('https://canai.example.com/', {}), null)
})
