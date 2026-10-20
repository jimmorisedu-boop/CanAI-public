// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { macroLoadState, macroSaveLabel } from './macroPersistence.js'

test('ошибка загрузки и повтор имеют отдельные честные состояния', () => {
  assert.equal(macroLoadState('failed'), 'load_failed')
  assert.equal(macroLoadState('retry'), 'loading')
  assert.equal(macroSaveLabel('load_failed'), 'Did not load')
})
