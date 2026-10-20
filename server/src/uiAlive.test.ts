import assert from 'node:assert/strict'
import test from 'node:test'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { looksLikeBrowser, markBrowserPoll, resetUiSigns, uiAlive } from './uiOpened.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null })

/**
 * ⚠️ Вторая вкладка — это конфликтная копия доски. Отметка «страницу просили»
 * живёт в памяти процесса и при перезапуске обнуляется, поэтому лаунчер
 * открывал вторую вкладку поверх живой первой: обе считали доску своей
 * (присутствие после перезапуска тоже пустое), и первая же запись проигравшей
 * становилась копией. На записи экрана 20.09.2026 доска исчезает мгновенно —
 * через две с половиной минуты после перезапуска, ровно когда доехала
 * генерация.
 */
test('живую вкладку видно по опросу состояния из браузера', () => {
  resetUiSigns()
  assert.equal(uiAlive(1_000), false, 'пока никто не опрашивал — вкладок нет')
  markBrowserPoll(1_000)
  assert.equal(uiAlive(1_000), true)
  assert.equal(uiAlive(14_000), true, 'опрос идёт чаще, чем раз в пятнадцать секунд')
  // ⚠️ Отметка ПРОТУХАЕТ: закрытая вкладка не должна вечно выдавать себя за живую.
  assert.equal(uiAlive(30_000), false)
})

/** ⚠️ Сам лаунчер тоже опрашивает состояние — его считать вкладкой нельзя. */
test('браузер отличается от лаунчера заголовками, а не именем программы', () => {
  assert.equal(looksLikeBrowser(headers({ 'sec-fetch-site': 'same-origin' })), true)
  // ⚠️ `sec-fetch-mode` в признак НЕ годится: замер показал, что его ставит и
  // `fetch` внутри самого Node — за вкладку сошёл бы любой наш запрос.
  assert.equal(looksLikeBrowser(headers({ 'sec-fetch-mode': 'cors' })), false)
  // Так приходит опрос от лаунчера и от curl.
  assert.equal(looksLikeBrowser(headers({ 'user-agent': 'WindowsPowerShell/5.1' })), false)
  assert.equal(looksLikeBrowser(headers({})), false)
})

test('оба лаунчера не открывают вторую вкладку поверх живой', () => {
  const windows = fsSync.readFileSync(path.join(repoRoot, 'start.ps1'), 'utf8')
  const mac = fsSync.readFileSync(path.join(repoRoot, 'start.command'), 'utf8')
  // ⚠️ Решение принимается ПОСЛЕ паузы и по СВЕЖЕМУ ответу: у перезапущенного
  // сервера отметка пуста, и открытой вкладке надо дать успеть опросить его.
  assert.match(windows, /Start-Sleep -Seconds 4/u)
  assert.ok(
    windows.includes(`if ($status -and [bool]$status.uiAlive) { return }`),
    'решение принимается по свежему ответу, а не по старому',
  )
  assert.match(mac, /sleep 4/u)
  assert.ok(mac.includes(`(*'\"uiAlive\":true'*) return`), 'маковский лаунчер обязан вести себя так же')
})
