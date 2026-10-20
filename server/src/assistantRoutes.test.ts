import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import express from 'express'

// Ручки своих помощников — на настоящем express-роутере.
//
// ⚠️ До этого теста их не вызывал никто (проверка 02.10.2026): убери строку из
// роутера — прогон зелёный, а кнопка в окне отвечает 404. Здесь же закреплено,
// что приём из файла отдаёт приложению замечания (`notes`): без них помощник,
// урезанный при приёме, выглядит «загруженным целиком».

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-assistant-routes-'))
process.env.CANAI_DATA_DIR = dataDir
process.env.CANAI_ENV_FILE = path.join(dataDir, 'none.env')
const { assistantRouter } = await import('./assistantRoutes.js')
const { MAX_IMPORT_DOCS, MAX_INSTRUCTIONS_CHARS } = await import('./assistants.js')

const stateFile = path.join(dataDir, 'assistants.json')
const backupFile = `${stateFile}.bak`
const docsDir = path.join(dataDir, 'assistant-docs')
// ⚠️ Считаем только файлы документов — по имени. Антивирус, проверяя только
// что удалённый файл, на миг оставляет рядом свой «ИМЯ.tmp», и сверка «всё,
// что есть в папке» от этого мигала.
// ⚠️ Папки документов может ещё не быть: её создаёт первый приложенный
// документ. Без запасного «пусто» случай, запущенный в одиночку, падал на
// чтении папки, которую в полном прогоне успевали завести соседние случаи.
const DOC_FILE = /^[0-9a-f-]{36}\.txt$/u
const docFiles = async (): Promise<string[]> => (
  (await fs.readdir(docsDir).catch(() => [] as string[])).filter((name) => DOC_FILE.test(name)).sort()
)

type Answer = { status: number; body: Record<string, unknown> | null }
type Send = (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Answer>

async function serve(t: TestContext): Promise<Send> {
  // Строки журнала дублируются в консоль — в отчёте прогона они только шум.
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const app = express()
  app.use(express.json({ limit: '50mb' }))
  app.use('/api', assistantRouter)
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return async (method, url, body, headers) => {
    const text = typeof body === 'string'
    const response = await fetch(`http://127.0.0.1:${address.port}/api${url}`, {
      method,
      headers: { ...(body === undefined || text ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: text ? body : JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json().catch(() => null) as Answer['body'] }
  }
}

const presetOf = (answer: Answer) => answer.body?.preset as { id: string; name: string; instructions: string; docs: Array<{ id: string }> }
const listed = async (send: Send): Promise<string[]> => (
  ((await send('GET', '/assistants')).body?.presets as Array<{ name: string }>).map((item) => item.name)
)

test.after(async () => {
  delete process.env.CANAI_DATA_DIR
  delete process.env.CANAI_ENV_FILE
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {})
})

test('приём из файла отвечает помощником и замечаниями; вошло всё — замечаний нет', async (t) => {
  const send = await serve(t)
  const whole = await send('POST', '/assistants/import', {
    name: 'Целиком', instructions: 'Проверяй композицию', modelId: 'gemini', docs: [{ name: 'бренд.txt', text: 'Вермилион.' }],
  })
  assert.equal(whole.status, 200)
  assert.equal(presetOf(whole).name, 'Целиком')
  assert.deepEqual(whole.body?.notes, [], 'пустой список, а не отсутствие поля: приложение читает его как «вошло всё»')

  const cut = await send('POST', '/assistants/import', {
    name: 'Урезанный',
    instructions: 'п'.repeat(MAX_INSTRUCTIONS_CHARS + 100),
    modelId: 'gemini',
    // Мусор вместо документа не роняет приём и местом не считается.
    docs: [null, { name: 'без текста' }, ...Array.from({ length: MAX_IMPORT_DOCS + 2 }, (_, index) => ({ name: `док-${index}`, text: 'текст' }))],
  })
  assert.equal(cut.status, 200)
  assert.equal(presetOf(cut).instructions.length, MAX_INSTRUCTIONS_CHARS)
  assert.equal(presetOf(cut).docs.length, MAX_IMPORT_DOCS)
  const notes = cut.body?.notes as string[]
  assert.equal(notes.length, 2, notes.join(' | '))
  assert.match(notes[0] ?? '', /^Instructions exceed 24,000 characters; using the beginning$/u)
  assert.match(notes[1] ?? '', /^Documents in file 22 — using 20$/u)
})

test('негодный файл — отказ запросу словами, и в библиотеку он не попадает', async (t) => {
  const send = await serve(t)
  const before = await listed(send)
  const inline = await send('POST', '/assistants/import', {
    name: 'С картинкой', instructions: '', modelId: 'gemini', docs: [{ name: 'снимок', text: 'data:image/png;base64,AAAA' }],
  })
  assert.equal(inline.status, 400)
  assert.match(String(inline.body?.error), /embedded file/u)

  for (const body of [{ instructions: 'без названия' }, { name: '   ', instructions: '' }, { name: 'Без инструкций' }]) {
    const nameless = await send('POST', '/assistants/import', body)
    assert.equal(nameless.status, 400)
    assert.equal(nameless.body?.error, 'The file has no assistant name or instructions')
  }
  assert.deepEqual(await listed(send), before)
})

test('выгрузка отдаёт тексты документов; помощника нет — «не найден»', async (t) => {
  const send = await serve(t)
  const saved = await send('POST', '/assistants', { name: 'Редактор', instructions: 'Правь текст', modelId: 'gemini' })
  const id = presetOf(saved).id
  const attached = await send('POST', `/assistants/${id}/docs`, 'Правило первое.', {
    'content-type': 'text/plain; charset=utf-8', 'x-file-name': encodeURIComponent('правила.txt'),
  })
  assert.equal(attached.status, 200)
  assert.deepEqual((await send('GET', `/assistants/${id}/export`)).body, {
    name: 'Редактор', instructions: 'Правь текст', modelId: 'gemini', docs: [{ name: 'правила.txt', text: 'Правило первое.' }],
  })

  const missing = await send('GET', '/assistants/нет-такого/export')
  assert.equal(missing.status, 404)
  assert.equal(missing.body?.error, 'Assistant not found')
  const orphan = await send('POST', '/assistants/нет-такого/docs', 'текст', { 'content-type': 'text/plain' })
  assert.equal(orphan.status, 400)
  assert.equal(orphan.body?.error, 'Assistant not found')
})

// ⚠️ Номер документа приходит из адреса запроса. Раньше файл стирался по нему
// без сверки с библиотекой: «../имя» уносило посторонний файл из папки данных.
test('удаление документа по чужому номеру не стирает посторонний файл', async (t) => {
  const send = await serve(t)
  const saved = await send('POST', '/assistants', { name: 'С документом', instructions: '', modelId: 'gemini' })
  const id = presetOf(saved).id
  const attached = await send('POST', `/assistants/${id}/docs`, 'знания', { 'content-type': 'text/plain' })
  const docId = (attached.body?.doc as { id: string }).id
  const outside = path.join(dataDir, 'посторонний.txt')
  await fs.writeFile(outside, 'не документ помощника')

  const foreign = await send('DELETE', `/assistants/${id}/docs/${encodeURIComponent('../посторонний')}`)
  assert.equal(foreign.status, 200)
  assert.equal(await fs.readFile(outside, 'utf8'), 'не документ помощника')
  assert.equal(await fs.readFile(path.join(docsDir, `${docId}.txt`), 'utf8'), 'знания', 'свой документ тоже на месте')

  assert.equal((await send('DELETE', `/assistants/${id}/docs/${docId}`)).status, 200)
  await assert.rejects(() => fs.access(path.join(docsDir, `${docId}.txt`)), 'свой документ убирается вместе с файлом')
})

// ⚠️ Беда с самой библиотекой — не «не найдено» и не «неверный запрос»: по этим
// кодам приложение показало бы «Помощник не найден» там, где надо объяснить,
// что список не читается и ничего не тронуто.
test('библиотека не читается — каждая ручка отвечает объяснением, а не «не найдено»', async (t) => {
  const send = await serve(t)
  const id = presetOf(await send('POST', '/assistants', { name: 'Жертва', instructions: '', modelId: 'gemini' })).id
  // Возвращаем библиотеку на место: случаи этого файла не должны зависеть от порядка.
  const good = await fs.readFile(stateFile, 'utf8')
  const goodBackup = await fs.readFile(backupFile, 'utf8').catch(() => null)
  t.after(async () => {
    await fs.writeFile(stateFile, good)
    if (goodBackup === null) await fs.rm(backupFile, { force: true })
    else await fs.writeFile(backupFile, goodBackup)
  })
  await fs.writeFile(stateFile, '{"presets":[{"id":"')
  await fs.writeFile(backupFile, '')
  const docs = await docFiles()

  const answers = [
    await send('GET', '/assistants'),
    await send('GET', `/assistants/${id}/export`),
    await send('POST', '/assistants', { name: 'Новый', instructions: '', modelId: 'gemini' }),
    await send('POST', '/assistants/import', { name: 'Из файла', instructions: '', modelId: 'gemini', docs: [{ name: 'д', text: 'т' }] }),
    await send('POST', `/assistants/${id}/duplicate`),
    await send('POST', '/assistants/active', { id }),
    await send('POST', `/assistants/${id}/docs`, 'текст', { 'content-type': 'text/plain' }),
    await send('DELETE', `/assistants/${id}`),
  ]
  for (const answer of answers) {
    assert.equal(answer.status, 500)
    assert.match(String(answer.body?.error), /^The assistant list cannot be read:/u)
  }
  assert.equal(await fs.readFile(stateFile, 'utf8'), '{"presets":[{"id":"', 'испорченный файл не перезаписан')
  assert.equal(await fs.readFile(backupFile, 'utf8'), '')
  assert.deepEqual(await docFiles(), docs, 'документов не прибавилось и не убавилось')
})
