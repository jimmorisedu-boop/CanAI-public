import assert from 'node:assert/strict'
import test from 'node:test'
import { createMacroLaunchRegistry } from './macroLaunches'

test('серия запусков одного макроса идёт параллельно и считается', () => {
  const registry = createMacroLaunchRegistry()
  const first = registry.begin('macro-1')
  const second = registry.begin('macro-1')
  const other = registry.begin('macro-2')

  assert.notEqual(first, second)
  assert.equal(registry.activeCount('macro-1'), 2)
  assert.equal(registry.activeCount('macro-2'), 1)

  registry.end('macro-1', first)
  assert.equal(registry.activeCount('macro-1'), 1)
  registry.end('macro-1', second)
  assert.equal(registry.activeCount('macro-1'), 0)
  assert.equal(registry.activeCount('macro-2'), 1)
  registry.end('macro-2', other)
})

test('«Стоп» останавливает все идущие прогоны макроса и только его', () => {
  const registry = createMacroLaunchRegistry()
  const a = registry.begin('macro-1')
  const b = registry.begin('macro-1')
  const foreign = registry.begin('macro-2')

  assert.equal(registry.cancelAll('macro-1'), true)
  assert.equal(registry.isCancelled(a), true)
  assert.equal(registry.isCancelled(b), true)
  assert.equal(registry.isCancelled(foreign), false)
})

test('запуск после остановки не наследует отмену', () => {
  const registry = createMacroLaunchRegistry()
  const stopped = registry.begin('macro-1')
  registry.cancelAll('macro-1')
  assert.equal(registry.isCancelled(stopped), true)

  // пользователь тут же жмёт макрос снова — новый прогон должен работать
  const fresh = registry.begin('macro-1')
  assert.equal(registry.isCancelled(fresh), false)

  // и остаётся рабочим даже после того, как остановленный прогон завершился
  registry.end('macro-1', stopped)
  assert.equal(registry.isCancelled(fresh), false)
  assert.equal(registry.activeCount('macro-1'), 1)
})

test('нечего останавливать — cancelAll честно возвращает false', () => {
  const registry = createMacroLaunchRegistry()
  assert.equal(registry.cancelAll('macro-1'), false)
  const token = registry.begin('macro-1')
  registry.end('macro-1', token)
  assert.equal(registry.cancelAll('macro-1'), false)
})

test('завершённый токен перестаёт считаться отменённым (переиспользование памяти)', () => {
  const registry = createMacroLaunchRegistry()
  const token = registry.begin('macro-1')
  registry.cancelAll('macro-1')
  registry.end('macro-1', token)
  assert.equal(registry.isCancelled(token), false)
})
