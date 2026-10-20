import assert from 'node:assert/strict'
import test from 'node:test'
import { startServerStatusMonitor } from './serverStatusMonitor'
import { canStartGeneration } from './generationAvailability'
import type { ServerStatus } from '../../types'
const status = { falConfigured: true, mockMode: false, accountCloudConfigured: true } as ServerStatus
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function clock() {
  const timers = new Map<number, () => void>()
  let id = 0
  return { timers, schedule: (run: () => void) => { timers.set(++id, run); return id }, unschedule: (key: unknown) => { timers.delete(key as number) }, next() { const [key, run] = timers.entries().next().value!; timers.delete(key); run() } }
}
test('временная ошибка статуса не блокирует непустой промпт навсегда', async () => {
  const c = clock(); let calls = 0; let latest: ServerStatus | null = null
  const monitor = startServerStatusMonitor({ read: async () => { if (++calls === 1) throw Error('сеть'); return status }, publish: value => { latest = value }, ...c })
  await tick()
  assert.equal(canStartGeneration(latest, true, 'local'), false)
  assert.equal(c.timers.size, 1, 'после ошибки запланировано переподключение')
  c.next(); await tick()
  assert.equal(canStartGeneration(latest, true, 'local'), true)
  assert.equal(canStartGeneration(latest, true, 'cloud'), true)
  monitor.dispose(); assert.equal(c.timers.size, 0)
})
test('поздний ответ после ухода с доски не меняет её состояние', async () => {
  const c = clock(); let finish!: (status: ServerStatus) => void; const published: unknown[] = []
  const monitor = startServerStatusMonitor({ read: () => new Promise(resolve => { finish = resolve }), publish: value => published.push(value), ...c })
  monitor.dispose(); finish(status); await tick()
  assert.deepEqual(published, []); assert.equal(c.timers.size, 0)
})
test('обновление настроек во время запроса проверяет статус ещё раз без параллельных запросов', async () => {
  const c = clock(); let finish!: (status: ServerStatus) => void; let calls = 0
  const monitor = startServerStatusMonitor({ read: () => { calls++; return calls === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve(status) }, publish: () => {}, ...c })
  monitor.refresh(); monitor.refresh(); assert.equal(calls, 1)
  finish(status); await tick(); assert.equal(calls, 2)
  monitor.dispose()
})

test('один сбой не поднимает тревогу и не гасит кнопку', async () => {
  // ⚠️ Раньше первая же неудачная проверка публиковала null — на экране
  // появлялась плашка «Сервер недоступен», а «Создать» гасла, хотя приложение
  // работало (жалоба 18.09.2026). На доске с картинками проверка статуса легко
  // оказывается в очереди за ними: браузер держит шесть соединений на адрес.
  const c = clock()
  let calls = 0
  const published: Array<ServerStatus | null> = []
  const monitor = startServerStatusMonitor({
    read: async () => { calls++; if (calls >= 2) throw Error('сеть'); return status },
    publish: value => { published.push(value) },
    ...c,
  })
  await tick()
  assert.deepEqual(published, [status], 'первый ответ показан сразу')

  // Два сбоя подряд — всё ещё молчим: на экране последний известный ответ.
  c.next(); await tick()
  c.next(); await tick()
  assert.deepEqual(published, [status], 'короткий сбой человека не касается')
  assert.equal(canStartGeneration(published.at(-1) ?? null, true, 'local'), true)

  // Третий подряд — это уже не случайность, тревожим.
  c.next(); await tick()
  assert.deepEqual(published, [status, null])
  monitor.dispose()
})

test('готовность публикуется только после ответа или исчерпания grace window', async () => {
  const c = clock()
  let calls = 0
  let ready = 0
  const monitor = startServerStatusMonitor({
    read: async () => { calls++; throw Error('сеть') },
    publish: () => {},
    onReady: () => { ready++ },
    ...c,
  })
  await tick()
  assert.equal(ready, 0, 'первый transient failure остаётся неизвестным')
  c.next(); await tick()
  c.next(); await tick()
  assert.equal(ready, 1, 'третий подряд сбой разрешает честный offline notice')
  c.next(); await tick()
  assert.equal(ready, 1, 'готовность публикуется один раз за monitor')
  assert.equal(calls, 4)
  monitor.dispose()
})

test('сервер ответил — тревога снимается и счётчик сбоев обнуляется', async () => {
  const c = clock()
  let failing = true
  const published: Array<ServerStatus | null> = []
  const monitor = startServerStatusMonitor({
    read: async () => { if (failing) throw Error('сеть'); return status },
    publish: value => { published.push(value) },
    ...c,
  })
  await tick()
  c.next(); await tick()
  c.next(); await tick()
  assert.deepEqual(published, [null], 'три сбоя подряд — тревога')

  failing = false
  c.next(); await tick()
  assert.deepEqual(published, [null, status])

  // И после выздоровления снова даём три попытки, а не тревожим с первой.
  failing = true
  c.next(); await tick()
  assert.deepEqual(published, [null, status], 'счётчик обнулился ответом сервера')
  monitor.dispose()
})
