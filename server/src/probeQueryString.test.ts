// Изолированная папка данных: тест не должен писать в рабочую server/data
// пользователя.
//
// ⚠️ Присвоить process.env ПЕРЕД строкой `import { config }` — недостаточно, и
// это не теория: в ES-модулях импорты выполняются РАНЬШЕ тела модуля, поэтому
// config успевал прочитать настоящий путь, и тест раскладывал edit-probe.png
// прямо в server/data/media пользователя — а t.after подчищал временную папку,
// то есть не тот файл. Мусор копился от прогона к прогону. Лечится только
// динамическим импортом, как в editSessionsLoad.test.ts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canai-probe-'))
process.env.CANAI_DATA_DIR = dataRoot
process.env.CANAI_ENV_FILE = path.join(dataRoot, '.env')

import assert from 'node:assert/strict'
import test from 'node:test'

const { config } = await import('./config.js')
const { probeLocalMediaDimensions } = await import('./storage.js')

// PNG 4×2, одна прозрачная строка — минимум, на котором читается заголовок IHDR
const PNG_4x2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAACiPUKrAAAAEklEQVR4nGP8//8/AzGAiSjVAAZZAwEP18ObAAAAAElFTkSuQmCC',
  'base64',
)

test('размеры читаются по ссылке С параметром ?v=… (сброс кэша внешнего редактора)', (t) => {
  fs.mkdirSync(config.mediaDir, { recursive: true })
  const file = path.join(config.mediaDir, 'edit-probe.png')
  fs.writeFileSync(file, PNG_4x2)
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))

  // контрольный замер: без параметра всё читается
  assert.deepEqual(probeLocalMediaDimensions('/media/edit-probe.png'), { width: 4, height: 2 })

  // после правки в Photoshop клиент хранит src с ?v=<mtime>
  // (useExternalEdit.ts: `${session.url}?v=${mtime}`), и путь обязан работать —
  // так делают все соседние места: refs.ts, fal.ts, editSessions.ts, routes.ts
  assert.deepEqual(
    probeLocalMediaDimensions('/media/edit-probe.png?v=1786012345'),
    { width: 4, height: 2 },
  )
})

// Сторож: статический импорт config/storage вернул бы ту же беду — тест снова
// начал бы писать в рабочую папку пользователя, и заметить это можно было бы
// только по мусору в server/data/media.
test('config подключается динамически, иначе изоляция папки не работает', () => {
  const source = fs.readFileSync(new URL(import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^import \{[^}]*\} from '\.\/config\.js'/m)
  assert.doesNotMatch(source, /^import \{[^}]*\} from '\.\/storage\.js'/m)
  assert.match(source, /await import\('\.\/config\.js'\)/)
})
