import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { isAllowedRemoteApi, isAllowedRemoteHost } from './remoteAllowlist.js'

// Самый важный сторож во всей планшетной части: он отвечает на вопрос «что
// именно доступно с устройства, стоящего в сети». Ошибка здесь стоит ключа
// fal или запуска программ на компьютере.

test('планшет умеет всё, ради чего он и нужен', () => {
  assert.equal(isAllowedRemoteApi('GET', '/projects'), true)
  assert.equal(isAllowedRemoteApi('GET', '/project'), true)
  assert.equal(isAllowedRemoteApi('POST', '/project'), true)
  assert.equal(isAllowedRemoteApi('POST', '/generate'), true)
  assert.equal(isAllowedRemoteApi('POST', '/canvas/actions/prepare'), true)
  assert.equal(isAllowedRemoteApi('GET', '/canvas/actions/prepare/job-1'), true)
  assert.equal(isAllowedRemoteApi('POST', '/canvas/actions/prepare/job-1/cancel'), true)
  assert.equal(isAllowedRemoteApi('GET', '/jobs/abc-123'), true)
  assert.equal(isAllowedRemoteApi('POST', '/jobs/abc-123/cancel'), true)
  assert.equal(isAllowedRemoteApi('POST', '/jobs/wait'), true)
  assert.equal(isAllowedRemoteApi('POST', '/assets/upload'), true)
  assert.equal(isAllowedRemoteApi('GET', '/session-draft'), true)
  assert.equal(isAllowedRemoteApi('POST', '/board-presence'), true)
  assert.equal(isAllowedRemoteApi('POST', '/prompt-chats/c1/messages'), true)
  assert.equal(isAllowedRemoteApi('PATCH', '/prompt-chats/preferences'), true)
  assert.equal(isAllowedRemoteApi('PATCH', '/prompt-chats/other-preferences'), false)
})

test('ключ fal с планшета недостижим', () => {
  // POST /settings пишет server/.env. Это главное, чего здесь быть не должно.
  assert.equal(isAllowedRemoteApi('POST', '/settings'), false)
  assert.equal(isAllowedRemoteApi('POST', '/settings/editor/browse'), false)
  assert.equal(isAllowedRemoteApi('POST', '/settings/editor/test'), false)
})

test('запуск программ и выключение приложения недостижимы', () => {
  assert.equal(isAllowedRemoteApi('POST', '/edit-sessions'), false)
  assert.equal(isAllowedRemoteApi('GET', '/edit-sessions'), false)
  assert.equal(isAllowedRemoteApi('POST', '/lifecycle/shutdown'), false)
  assert.equal(isAllowedRemoteApi('POST', '/media/reveal'), false)
})

test('настройки правятся с планшета только без секретов', () => {
  // PATCH принимает явный короткий список полей (порог сходства лиц, порог
  // подтверждения цены). POST пишет ключ fal и путь к Photoshop — он закрыт.
  assert.equal(isAllowedRemoteApi('GET', '/settings'), true)
  assert.equal(isAllowedRemoteApi('PATCH', '/settings'), true)
  assert.equal(isAllowedRemoteApi('PUT', '/settings'), false)
  assert.equal(isAllowedRemoteApi('POST', '/settings'), false)
})

test('правка клипа работает, а докачка компонентов — нет', () => {
  // Резать, доставать кадр и звук — обычные операции над файлом доски, их
  // место там же, где сам файл. Докачка пишет в runtime/ и остаётся за столом.
  assert.equal(isAllowedRemoteApi('POST', '/media/cut-video'), true)
  assert.equal(isAllowedRemoteApi('POST', '/media/extract-audio'), true)
  assert.equal(isAllowedRemoteApi('POST', '/media/audio-peaks'), true)
  assert.equal(isAllowedRemoteApi('POST', '/media/probe-video'), true)
  assert.equal(isAllowedRemoteApi('GET', '/media-tools/ffmpeg'), true)
  assert.equal(isAllowedRemoteApi('POST', '/media-tools/ffmpeg/prepare'), false)
  assert.equal(isAllowedRemoteApi('GET', '/face-models'), true)
  assert.equal(isAllowedRemoteApi('POST', '/face-models/prepare'), false)
})

test('макросы запускаются, но не правятся', () => {
  // Запускать с планшета стало можно, когда движок переехал на сервер: прогон
  // переживает заблокированный экран. Править граф по-прежнему нельзя —
  // редактор нод на планшет не переносится.
  assert.equal(isAllowedRemoteApi('GET', '/macros'), true)
  assert.equal(isAllowedRemoteApi('GET', '/macros/abc/plan'), true)
  assert.equal(isAllowedRemoteApi('POST', '/macros/abc/run'), true)
  assert.equal(isAllowedRemoteApi('GET', '/macro-runs'), true)
  assert.equal(isAllowedRemoteApi('POST', '/macro-runs/r1/cancel'), true)
  assert.equal(isAllowedRemoteApi('POST', '/macros'), false)
  assert.equal(isAllowedRemoteApi('DELETE', '/macros/1'), false)
  assert.equal(isAllowedRemoteApi('POST', '/macros/order'), false)
  assert.equal(isAllowedRemoteApi('POST', '/workflow-draft'), false)
})

test('помощника на планшете можно включить и выключить — и только это', () => {
  // ⚠️ Ряд помощников на планшете — это кнопки-переключатели, и на своей доске
  // они зовут свой сервер: список (GET /assistants) и выбор включённого
  // (POST /assistants/active). Второй ручки в белом списке не было, дверь
  // отвечала «Это действие доступно только на компьютере», и переключатель
  // молча откатывался — помощника с планшета было не включить (проверка
  // 02.10.2026). Обе ручки, которые зовёт панель, названы здесь поимённо.
  assert.equal(isAllowedRemoteApi('GET', '/assistants'), true)
  assert.equal(isAllowedRemoteApi('POST', '/assistants/active'), true)
  // Открыт ровно выбор включённого: в ответе тот же список, что у GET
  // /assistants, текстов документов в нём нет (закреплено следующим тестом).
  // Соседние адреса и методы остаются закрыты.
  for (const [method, path] of [
    ['GET', '/assistants/active'],
    ['PUT', '/assistants/active'],
    ['PATCH', '/assistants/active'],
    ['DELETE', '/assistants/active'],
    ['POST', '/assistants/active/docs'],
    ['POST', '/assistants/active/'],
    ['POST', '/assistants/activeX'],
    ['POST', '/assistants/abc'],
    ['POST', '/assistants/../assistants/active/../abc/docs'],
  ] as const) {
    assert.equal(isAllowedRemoteApi(method, path), false, `${method} ${path}`)
  }
})

// ⚠️ И в списке, и в тесте выше стояло: выбор включённого «не отдаёт ни
// инструкций, ни текстов документов». Про инструкции это неправда: ручка
// отвечает всей библиотекой, как GET /assistants (проверка 03.10.2026 на
// настоящем роутере за настоящей дверью). Утечки тут нет — список открыт
// планшету давно, — но поверивший таким словам решит, что инструкции с
// планшета недоступны, и станет на это полагаться. Поэтому сам факт закреплён
// поведением, а слова в списке сверены с ним.
test('выбор включённого отвечает тем же списком, что GET /assistants: инструкции есть, текстов документов нет', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-remote-assistants-'))
  process.env.CANAI_DATA_DIR = dataDir
  process.env.CANAI_ENV_FILE = path.join(dataDir, 'none.env')
  // Строки журнала дублируются в консоль — в отчёте прогона они только шум.
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  // Импорт — после папки данных: её выбирает config при первой загрузке.
  const { assistantRouter } = await import('./assistantRoutes.js')
  const { addAssistantDoc, saveAssistant } = await import('./assistants.js')

  const INSTRUCTIONS = 'ИНСТРУКЦИИ-ПОМОЩНИКА-12345'
  const DOC_TEXT = 'ТЕКСТ-ДОКУМЕНТА-67890'
  const preset = await saveAssistant({ id: null, name: 'Проба', instructions: INSTRUCTIONS, modelId: 'gemini' })
  await addAssistantDoc(preset.id, 'знания.txt', DOC_TEXT)

  const app = express()
  app.use(express.json())
  // Та же дверь, что у планшета: чего нет в белом списке, до роутера не доходит.
  app.use('/api', (req, res, next) => {
    if (isAllowedRemoteApi(req.method, req.path)) next()
    else res.status(403).json({ error: 'Это действие доступно только на компьютере' })
  }, assistantRouter)
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    delete process.env.CANAI_DATA_DIR
    delete process.env.CANAI_ENV_FILE
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {})
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const send = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${url}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return { status: response.status, text, body: JSON.parse(text) as { presets?: unknown; activeId?: unknown } }
  }

  const list = await send('GET', '/assistants')
  assert.equal(list.status, 200)
  assert.ok(list.text.includes(INSTRUCTIONS), 'список отдаёт инструкции — так было и до ручки выбора')
  assert.ok(!list.text.includes(DOC_TEXT))

  for (const id of [preset.id, null]) {
    const chosen = await send('POST', '/assistants/active', { id })
    assert.equal(chosen.status, 200)
    assert.equal(chosen.body.activeId, id)
    assert.deepEqual(chosen.body.presets, list.body.presets, 'тот же список, что у GET /assistants')
    assert.ok(chosen.text.includes(INSTRUCTIONS), 'инструкции в ответе ЕСТЬ')
    assert.ok(!chosen.text.includes(DOC_TEXT), 'текстов документов в ответе нет')
  }
  // Тексты документов отдаёт только выгрузка — а она за дверью не видна.
  assert.equal((await send('GET', `/assistants/${preset.id}/export`)).status, 403)

  // Слова в списке — про то же самое.
  const source = readFileSync(new URL('./remoteAllowlist.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const rule = source.indexOf("pattern: /^\\/assistants\\/active$/")
  const comment = source.slice(source.lastIndexOf("pattern: /^\\/assistants$/", rule), rule)
  assert.ok(rule > 0 && comment.length > 0, 'ручка выбора стоит в списке сразу за списком помощников')
  assert.match(comment.replace(/\n\s*\/\/ ?/gu, ' '), /отвечает тем же списком, что GET \/assistants: имена и инструкции в нём есть, текстов документов нет/u)
  assert.doesNotMatch(comment, /ни инструкций/u, 'инструкции ручка отдаёт — обратного писать нельзя')
})

test('библиотека помощников с планшета недостижима: ни выгрузки, ни приёма, ни удаления', () => {
  // ⚠️ Выгрузка отдаёт ТЕКСТЫ документов знаний, приём и удаление меняют
  // библиотеку. Всё это закрыто тем, что в белом списке у помощников только
  // список и выбор включённого, — но закрыто молча: впиши кто-нибудь эти
  // ручки в список, прежний тест остался бы зелёным, а тексты документов ушли
  // бы на устройство в сети (проверка 02.10.2026). Поэтому отказ записан явно.
  assert.equal(isAllowedRemoteApi('GET', '/assistants'), true)
  assert.equal(isAllowedRemoteApi('GET', '/assistants/abc/export'), false)
  assert.equal(isAllowedRemoteApi('POST', '/assistants/import'), false)
  assert.equal(isAllowedRemoteApi('DELETE', '/assistants/abc'), false)
  // Редактора помощников на планшете нет: заводить и править их тоже нельзя.
  assert.equal(isAllowedRemoteApi('POST', '/assistants'), false)
  assert.equal(isAllowedRemoteApi('PATCH', '/assistants/abc'), false)
  assert.equal(isAllowedRemoteApi('POST', '/assistants/abc/docs'), false)
})

test('библиотеки сетевой доски с планшета через компьютер не правятся', () => {
  // Мост к серверу команды (/cloud-account/*) — ручки компьютера. Планшет с
  // сетевой доской ходит к серверу команды сам, а через дверь компьютера ему
  // туда дороги нет: ни удаления, ни «Сделать общим», ни копии, ни создания.
  for (const [method, path] of [
    ['GET', '/cloud-account/macros'],
    ['POST', '/cloud-account/macros'],
    ['DELETE', '/cloud-account/macros/abc'],
    ['POST', '/cloud-account/macros/abc/share'],
    ['POST', '/cloud-account/macros/abc/copy-personal'],
    ['GET', '/cloud-account/assistants'],
    ['POST', '/cloud-account/assistants'],
    ['DELETE', '/cloud-account/assistants/abc'],
    ['POST', '/cloud-account/assistants/abc/share'],
    ['POST', '/cloud-account/assistants/abc/copy-personal'],
  ] as const) {
    assert.equal(isAllowedRemoteApi(method, path), false, `${method} ${path}`)
  }
})

test('LAN агент видит только библиотеку/каталог и локальный task lifecycle', () => {
  for (const [method, path] of [
    ['GET', '/agents/llm/catalog'],
    ['GET', '/agents/generation/catalog'],
    ['POST', '/agents/generation/capture'],
    ['GET', '/agents/packages'],
    ['GET', '/agents/packages/canai.demo'],
    ['POST', '/agent-tasks'],
    ['GET', '/agent-tasks'],
    ['GET', '/agent-tasks/agent-task-1'],
    ['GET', '/agent-tasks/agent-task-1/events'],
    ['POST', '/agent-tasks/agent-task-1/pause'],
    ['POST', '/agent-tasks/agent-task-1/resume'],
    ['POST', '/agent-tasks/agent-task-1/cancel'],
    ['POST', '/agent-tasks/agent-task-1/reviews/review-1/decision'],
  ] as const) {
    assert.equal(isAllowedRemoteApi(method, path), true, `${method} ${path}`)
  }
  for (const [method, path] of [
    ['GET', '/agents/runtime/python'],
    ['POST', '/agents/runtime/python/install'],
    ['POST', '/agents/packages/upload'],
    ['POST', '/agents/packages/check'],
    ['POST', '/agents/packages/install'],
    ['POST', '/agents/packages/update'],
    ['POST', '/agents/packages/enable'],
    ['POST', '/agents/packages/remove'],
  ] as const) {
    assert.equal(isAllowedRemoteApi(method, path), false, `${method} ${path}`)
  }
})

test('корзина доступна целиком — включая необратимое', () => {
  // Планшет — рабочее место, а не пульт (решение пользователя 26.08.2026),
  // поэтому корзина работает так же, как на компьютере. От промаха пальцем
  // защищает не запрет, а второе нажатие в самом интерфейсе.
  assert.equal(isAllowedRemoteApi('DELETE', '/projects/abc'), true)
  assert.equal(isAllowedRemoteApi('POST', '/project-trash/abc/restore'), true)
  assert.equal(isAllowedRemoteApi('DELETE', '/project-trash/abc'), true)
  assert.equal(isAllowedRemoteApi('DELETE', '/project-trash'), true)
})

test('обход пути не помогает', () => {
  assert.equal(isAllowedRemoteApi('POST', '/projects/../settings'), false)
  assert.equal(isAllowedRemoteApi('POST', '/generate/../settings'), false)
})

test('строка запроса не превращает чужой путь в разрешённый', () => {
  assert.equal(isAllowedRemoteApi('GET', '/project?project=1'), true)
  assert.equal(isAllowedRemoteApi('POST', '/settings?x=/project'), false)
})

test('неизвестная ручка закрыта по умолчанию', () => {
  // Ради этого список и белый: новая ручка недоступна с планшета, пока её не
  // впишут сюда руками.
  assert.equal(isAllowedRemoteApi('GET', '/что-то-новое'), false)
  assert.equal(isAllowedRemoteApi('POST', '/face/detect'), false)
  assert.equal(isAllowedRemoteApi('POST', '/media-tools/ffmpeg/prepare'), false)
})

test('в планшетную дверь пускают только из своей сети', () => {
  // Чужой домен, направленный на этот адрес, приходит со СВОИМ именем в Host —
  // так его и отличаем от настоящего адреса в локальной сети.
  assert.equal(isAllowedRemoteHost('127.0.0.1'), true)
  assert.equal(isAllowedRemoteHost('192.168.1.42'), true)
  assert.equal(isAllowedRemoteHost('10.0.0.7'), true)
  assert.equal(isAllowedRemoteHost('172.20.3.1'), true)
  assert.equal(isAllowedRemoteHost('evil.example.com'), false)
  assert.equal(isAllowedRemoteHost('8.8.8.8'), false)
  assert.equal(isAllowedRemoteHost('172.32.0.1'), false)
})

test('манифест отдаётся файлом, а не проваливается в фолбэк на страницу', () => {
  // ⚠️ Ландшафт у страницы, добавленной на домашний экран, держит МАНИФЕСТ —
  // ничего другого веб-странице для этого не дано. Раздача статики
  // заканчивается фолбэком app.get('*') на tablet.html, и без отдельной
  // строки по адресу манифеста приходила разметка: браузер писал «Manifest:
  // Line 1, column 1, Syntax error», а блокировка поворота молча не работала.
  // Единственным следом была строка в консоли, куда на планшете не смотрят.
  const source = readFileSync(new URL('./remoteApp.ts', import.meta.url), 'utf8')
  const manifest = source.indexOf("app.get('/tablet.webmanifest'")
  const fallback = source.indexOf("app.get('*'")
  assert.ok(manifest > 0, 'нет отдельной раздачи /tablet.webmanifest')
  assert.ok(manifest < fallback, 'раздача манифеста должна стоять ДО фолбэка на страницу')
  assert.match(source.slice(manifest, manifest + 260), /application\/manifest\+json/)
})
