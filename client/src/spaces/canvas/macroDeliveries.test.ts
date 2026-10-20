import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deliverMacroResult,
  parkedMacroResults,
  registerMacroDeliverySink,
  resetMacroDeliveries,
  type MacroDelivery,
} from './macroDeliveries'

// Жалоба 19.08.2026: «запустил макрос, зашёл в него, потом случайно вышел с
// доски — генерации не появляются, хз выполнились они или нет». Прогон
// продолжает работать и доводит ОПЛАЧЕННЫЕ генерации до конца, а класть их
// было некуда: стор умирает вместе с доской.

function delivery(label: string, url: string): MacroDelivery {
  return { result: { url, mime: 'image/png' }, label }
}

test('доска открыта — результат отдаётся сразу', () => {
  resetMacroDeliveries()
  const got: string[] = []
  registerMacroDeliverySink('board-1', (d) => got.push(d.result.url ?? ''))
  deliverMacroResult('board-1', delivery('Макрос', '/media/a.png'))
  assert.deepEqual(got, ['/media/a.png'])
  assert.equal(parkedMacroResults('board-1'), 0)
})

test('доска закрыта — результат ждёт её и доезжает при открытии', () => {
  resetMacroDeliveries()
  deliverMacroResult('board-1', delivery('Макрос', '/media/a.png'))
  deliverMacroResult('board-1', delivery('Макрос', '/media/b.png'))
  assert.equal(parkedMacroResults('board-1'), 2)

  const got: string[] = []
  registerMacroDeliverySink('board-1', (d) => got.push(d.result.url ?? ''))
  // порядок сохраняется: объекты встают так же, как встали бы вживую
  assert.deepEqual(got, ['/media/a.png', '/media/b.png'])
  assert.equal(parkedMacroResults('board-1'), 0, 'отданное больше не хранится')
})

test('результаты чужой доски не приезжают на открытую', () => {
  resetMacroDeliveries()
  deliverMacroResult('board-2', delivery('Макрос', '/media/чужое.png'))
  const got: string[] = []
  registerMacroDeliverySink('board-1', (d) => got.push(d.result.url ?? ''))
  assert.deepEqual(got, [])
  assert.equal(parkedMacroResults('board-2'), 1, 'ждёт свою доску')
})

test('уход с доски снимает приём, возврат забирает накопленное', () => {
  resetMacroDeliveries()
  const first: string[] = []
  const stop = registerMacroDeliverySink('board-1', (d) => first.push(d.result.url ?? ''))
  deliverMacroResult('board-1', delivery('Макрос', '/media/до.png'))
  stop() // ушли с доски — стор умер вместе с ней
  deliverMacroResult('board-1', delivery('Макрос', '/media/после.png'))
  assert.deepEqual(first, ['/media/до.png'], 'мёртвый стор больше ничего не получает')

  const second: string[] = []
  registerMacroDeliverySink('board-1', (d) => second.push(d.result.url ?? ''))
  assert.deepEqual(second, ['/media/после.png'])
})

test('отписка старого приёмника не отменяет новый', () => {
  // Доска пересобирается (App меняет key), и порядок «новый смонтировался →
  // старый отписался» на React обычен: снимать чужую регистрацию нельзя.
  resetMacroDeliveries()
  const stopOld = registerMacroDeliverySink('board-1', () => {})
  const got: string[] = []
  registerMacroDeliverySink('board-1', (d) => got.push(d.result.url ?? ''))
  stopOld()
  deliverMacroResult('board-1', delivery('Макрос', '/media/новое.png'))
  assert.deepEqual(got, ['/media/новое.png'])
})

test('болванка передаётся вместе с результатом', () => {
  // Пока доска на экране, результат обязан встать НА МЕСТО своей заглушки, а не
  // рядом: ряд болванок расставлен заранее и не должен разъезжаться.
  resetMacroDeliveries()
  const got: Array<string | undefined> = []
  registerMacroDeliverySink('board-1', (d) => got.push(d.jobId))
  deliverMacroResult('board-1', { ...delivery('Макрос', '/media/a.png'), jobId: 'job-7' })
  assert.deepEqual(got, ['job-7'])
})
