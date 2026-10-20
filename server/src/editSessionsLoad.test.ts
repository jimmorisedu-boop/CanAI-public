import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// edit-sessions.json — единственное, что защищает копию, открытую в Photoshop,
// от сборщика мусора media. Если файл не читается (битый JSON, EACCES от
// антивируса), ensureLoaded обязан падать КАЖДЫЙ раз: gcMedia ловит исключение
// и пропускает уборку целиком. Молчаливый ответ «активных сессий нет» означает,
// что GC снесёт копию, пока пользователь ещё правит её в редакторе.
//
// Папка данных одна на весь файл: config читает CANAI_DATA_DIR при ПЕРВОМ
// импорте и дальше держит её намертво, поэтому подменять папку между тестами
// бессмысленно. Изолируем не папку, а состояние модуля — свежим импортом.

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-edit-sessions-'))
process.env.CANAI_DATA_DIR = dataDir
const sessionsFile = path.join(dataDir, 'edit-sessions.json')

test.after(async () => {
  delete process.env.CANAI_DATA_DIR
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

let generation = 0
async function freshModule(seed: string | null): Promise<typeof import('./editSessions.js')> {
  if (seed === null) await fs.rm(sessionsFile, { force: true })
  else await fs.writeFile(sessionsFile, seed)
  generation += 1
  return import(`./editSessions.js?gen=${generation}`)
}

test('контроль: без файла сессий список пуст и не падает', async () => {
  const { activeEditFileNames } = await freshModule(null)
  assert.deepEqual(await activeEditFileNames(), [])
  assert.deepEqual(await activeEditFileNames(), [])
})

test('контроль: целый файл сессий читается', async () => {
  const { activeEditFileNames } = await freshModule(
    JSON.stringify({
      version: 1,
      sessions: [{ id: 'a', fileName: 'edit-a.png', createdAt: Date.now() }],
    }),
  )
  assert.deepEqual(await activeEditFileNames(), ['edit-a.png'])
})

test('битый файл сессий обязан падать и на ВТОРОМ вызове тоже', async () => {
  const { activeEditFileNames } = await freshModule('{ это не JSON')

  await assert.rejects(() => activeEditFileNames(), 'первый вызов обязан сообщить о беде')
  // Раньше здесь возвращался пустой список: флаг «уже загружено» ставился ДО
  // чтения, поэтому вторая попытка молча делала вид, что активных сессий нет.
  // Ровно этот ответ и разрешает gcMedia удалить edit-копию из media.
  await assert.rejects(
    () => activeEditFileNames(),
    'второй вызов не должен молча отвечать «сессий нет»',
  )
})
