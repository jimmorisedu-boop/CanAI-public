import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'log.ts'),
  'utf8',
)

/**
 * ⚠️ Прогон тестов не имеет права писать в ЖИВОЙ журнал разработчика.
 * Папку данных выбирает `config.ts` при импорте, а тест, который её не задал,
 * попадал прямо в `server/data/logs/server.log`: полный прогон заливал туда
 * сотни строк «доска открыта за 1 мс» и вытеснял ротацией настоящие записи —
 * ровно те, по которым потом разбирают жалобу «приложение вылетает» (найдено
 * 19.09.2026 при разборе такой жалобы).
 *
 * ⚠️ Запись глушим ТОЛЬКО когда своей папки нет. Тест, который честно задал
 * `CANAI_DATA_DIR`, пишет как обычно — иначе нечем было бы проверять сам журнал.
 */
test('тестовый прогон без своей папки данных в журнал не пишет', () => {
  assert.match(source, /process\.env\.NODE_TEST_CONTEXT/u, 'признак тестового процесса обязателен')
  assert.match(source, /!process\.env\.CANAI_DATA_DIR/u, 'своя папка данных снимает глушение')
  assert.match(source, /function writeLine\(line: string\): void \{\s*\n\s*if \(testRunWithoutOwnData\) return/u)
  // Обе точки записи ходят через одну функцию: вторая копия разъехалась бы.
  assert.equal(source.split('fs.appendFileSync(logFile').length - 1, 1, 'запись в файл должна быть одна')
})

/** Сам признак: в этом процессе он взведён, и записи не случается. */
test('признак взведён прямо здесь — значит правило живое, а не написанное', () => {
  assert.equal(process.env.NODE_TEST_CONTEXT ? true : false, true)
})
