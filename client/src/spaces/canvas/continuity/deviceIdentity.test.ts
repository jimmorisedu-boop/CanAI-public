// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { deviceNameFrom } from './deviceIdentity'

// Имя устройства человек читает в карточке «Доска открыта на …», и оно должно
// называть вещь так, как называет её он сам.

const IPAD_OS_18 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

test('айпад, притворяющийся маком, узнаётся по касаниям', () => {
  // iPadOS с 13-й версии представляется Macintosh — по строке браузера их не
  // различить вовсе, и единственный признак планшета здесь это касания.
  assert.equal(deviceNameFrom(IPAD_OS_18, { maxTouchPoints: 5 }), 'iPad')
  assert.equal(deviceNameFrom(MAC_SAFARI, { maxTouchPoints: 0 }), 'Mac')
})

test('честный айпад узнаётся по имени', () => {
  assert.equal(deviceNameFrom('Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)', {}), 'iPad')
})

test('Windows называется Windows', () => {
  assert.equal(deviceNameFrom(WINDOWS_CHROME, { maxTouchPoints: 0 }), 'Windows')
})

test('сенсорный ноутбук на Windows остаётся Windows', () => {
  // Касания есть, но это не планшет: слово Windows важнее числа точек.
  assert.equal(deviceNameFrom(WINDOWS_CHROME, { maxTouchPoints: 10 }), 'Windows')
})

test('андроид различает планшет и телефон', () => {
  assert.equal(deviceNameFrom('Mozilla/5.0 (Linux; Android 14; Pixel Tablet)', { maxTouchPoints: 5 }), 'Android tablet')
  assert.equal(deviceNameFrom('Mozilla/5.0 (Linux; Android 14; Pixel 8)', { maxTouchPoints: 1 }), 'Android phone')
})

test('неизвестное устройство получает имя, а не пустоту', () => {
  assert.equal(deviceNameFrom('', {}), 'another device')
})

test('вкладка и устройство — разные личности', async () => {
  const { clientId, tabId, ownerId, isSameDevice } = await import('./deviceIdentity')
  // ⚠️ Владение доской считалось по одному id устройства, а он общий на все
  // вкладки браузера: вторая вкладка не считалась другим держателем, писала
  // доску наравне с первой, и сервер делал конфликтные копии (видео 18.09.2026).
  assert.equal(ownerId(), `${clientId()}~${tabId()}`)
  assert.notEqual(clientId(), tabId())

  // Свой же id — это «моё устройство», чужой — нет.
  assert.equal(isSameDevice(ownerId()), true)
  assert.equal(isSameDevice(`${clientId()}~другая-вкладка`), true)
  assert.equal(isSameDevice('чужое-устройство~вкладка'), false)
  assert.equal(isSameDevice(null), false)
  assert.equal(isSameDevice(''), false)
})

// ⚠️ sessionStorage КОПИРУЕТСЯ в новую вкладку, открытую из этой (window.open,
// «Дублировать вкладку»): проверено вживую в Chrome 21.09.2026 — вкладка из
// галереи по Ctrl+клику получала ТОТ ЖЕ id. Две вкладки одной доски были для
// сервера одним держателем, обе писали доску, и вторая запись уезжала в
// конфликтную копию. Живая вкладка держит замок на своё имя, дубль его видит.
function fakeLocks() {
  const held = new Set<string>()
  const api = {
    async request(name: string, _options: { ifAvailable: boolean }, callback: (lock: unknown) => unknown) {
      if (held.has(name)) return callback(null)
      held.add(name)
      return callback({ name })
    },
  }
  return { held, api }
}

test('вкладка с ничьим именем оставляет его себе — F5 имя не меняет', async () => {
  const { claimTabId } = await import('./deviceIdentity')
  const locks = fakeLocks()
  const remembered: string[] = []
  const id = await claimTabId({ current: 'вкладка-A', locks: locks.api, makeId: () => 'вкладка-B', remember: (next) => remembered.push(next) })
  assert.equal(id, 'вкладка-A')
  assert.deepEqual(remembered, [])
  assert.equal(locks.held.has('canai-tab:вкладка-A'), true, 'имя занято, пока страница жива')
})

test('дубль с копией sessionStorage берёт себе новое имя', async () => {
  const { claimTabId } = await import('./deviceIdentity')
  const locks = fakeLocks()
  // Оригинал уже держит своё имя.
  await claimTabId({ current: 'вкладка-A', locks: locks.api, makeId: () => 'лишнее', remember: () => {} })
  const remembered: string[] = []
  const id = await claimTabId({ current: 'вкладка-A', locks: locks.api, makeId: () => 'вкладка-B', remember: (next) => remembered.push(next) })
  assert.equal(id, 'вкладка-B')
  assert.deepEqual(remembered, ['вкладка-B'], 'новое имя обязано остаться у дубля и после F5')
  assert.equal(locks.held.has('canai-tab:вкладка-B'), true, 'третья копия увидит и это имя занятым')
})

test('замок молчит — работа не встаёт', async () => {
  const { claimTabId } = await import('./deviceIdentity')
  const silent = { request: () => new Promise<unknown>(() => {}) }
  const id = await claimTabId({ current: 'вкладка-A', locks: silent, makeId: () => 'вкладка-B', remember: () => {}, timeoutMs: 5 })
  assert.equal(id, 'вкладка-A')
})

test('сломанный замок оставляет имя прежним', async () => {
  const { claimTabId } = await import('./deviceIdentity')
  const broken = { request: () => Promise.reject(new Error('SecurityError')) }
  const throwing = { request: () => { throw new Error('нет замков') } }
  assert.equal(await claimTabId({ current: 'вкладка-A', locks: broken, makeId: () => 'вкладка-B', remember: () => {} }), 'вкладка-A')
  assert.equal(await claimTabId({ current: 'вкладка-A', locks: throwing, makeId: () => 'вкладка-B', remember: () => {} }), 'вкладка-A')
})

test('ничьё имя после настоящей проверки замком остаётся прежним', async () => {
  // Node 25 умеет Web Locks — здесь проверка идёт так же, как в браузере.
  const { verifiedOwnerId, ownerId } = await import('./deviceIdentity')
  assert.equal(await verifiedOwnerId(), ownerId())
})

test('без замков (планшет по http) имя проверенным считается сразу', async () => {
  const { verifiedTabId, tabId } = await import('./deviceIdentity')
  const id = verifiedTabId(null)
  assert.equal(typeof id, 'string', 'ждать нечего — отмечаться можно сразу')
  assert.equal(id, tabId())
})
