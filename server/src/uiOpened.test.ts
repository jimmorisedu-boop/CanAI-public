import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { markUiOpened, uiOpened } from './uiOpened.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * ⚠️ Лаунчер открывает адрес и до сих пор просто ВЕРИЛ, что браузер по нему
 * пришёл. Chrome с несколькими профилями встречает холодный запуск экраном
 * «Who's using Chrome?» и открытый адрес при этом теряет: порт слушает, доски
 * на месте, а человек смотрит на выбор профиля и видит, что канвас не
 * открылся сам (09.09.2026). Отличить «браузер пришёл» от «браузер не пришёл»
 * может только тот, кто раздаёт страницу.
 */
test('отметка ставится один раз и держится до конца жизни процесса', () => {
  assert.equal(uiOpened(), false, 'пока за страницей не пришли — не открыт')
  markUiOpened()
  assert.equal(uiOpened(), true)
  markUiOpened()
  assert.equal(uiOpened(), true, 'вторая вкладка ничего не меняет')
})

/**
 * ⚠️ Отметка обязана стоять ДО раздачи собранного клиента: `express.static`
 * отвечает на `/` сам и до следующего обработчика дело уже не доходит.
 */
test('отметку ставит раздача интерфейса, а статику она пропускает дальше', () => {
  const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf8')
  const marker = source.indexOf('markUiOpened()')
  const static_ = source.indexOf('express.static(clientDist)')

  assert.ok(marker > 0 && static_ > 0, 'оба места должны существовать')
  assert.ok(marker < static_, 'иначе статика ответит раньше и отметка не встанет')
  assert.match(source, /app\.get\(\['\/', '\/index\.html'\]/u)
  assert.match(source, /markUiOpened\(\)\s*\n\s*next\(\)/u, 'страницу всё равно отдаёт статика')
})

/** Лаунчер спрашивает об этом ровно одним способом — через /api/status. */
test('состояние видно снаружи вместе с отпечатком сервера', () => {
  const routes = fs.readFileSync(path.join(here, 'routes.ts'), 'utf8')
  const status = routes.slice(routes.indexOf("apiRouter.get('/status'"), routes.indexOf("apiRouter.post('/lifecycle/shutdown'"))

  assert.match(status, /uiOpened: uiOpened\(\)/u)
  assert.match(status, /serverFingerprint: config\.serverFingerprint/u)
})
