import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Ежедневный лимит генераций с планшета (пункт плана аудита 3): сколько
// локальных оплачиваемых генераций за день можно запустить с планшета.
// Считается только «честный локальный путь» — mock и сетевые проекты сюда
// не попадают (проверяется в routes.ts по generationRoute === 'local').
//
// Гонку двух одновременных запросов через лимит не воспроизводим — счётчик
// ходит под собственным замком модуля. Здесь — дневная арифметика: досчёт до
// лимита и сброс в полночь по локальной дате.
//
// Папка данных одна на весь файл (config читает CANAI_DATA_DIR при первом
// импорте), поэтому модуль пере-импортируем свежим каждый раз — так же, как
// в editSessionsLoad.test.ts.

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-tablet-daily-limit-'))
process.env.CANAI_DATA_DIR = dataDir

test.after(async () => {
  delete process.env.CANAI_DATA_DIR
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

let generation = 0
async function freshModule(): Promise<typeof import('./tabletDailyLimit.js')> {
  generation += 1
  return import(`./tabletDailyLimit.js?gen=${generation}`)
}

/** Дата для локальной полночи между двумя календарными днями. */
function nextDayMidnight(from: Date): Date {
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  return d
}

test('лимит считает оплачиваемые локальные запуски и запирает при исчерпании', async () => {
  const mod = await freshModule()
  const now = new Date('2026-10-05T12:00:00')

  // Лимит выключен (0) — всегда можно.
  assert.equal(await mod.takeLocalGenerationFromTablet(0, now), true)

  // Лимит 2: первые две заявки проходят, третья упирается.
  assert.equal(await mod.takeLocalGenerationFromTablet(2, now), true)
  assert.equal(await mod.takeLocalGenerationFromTablet(2, now), true)
  assert.equal(await mod.takeLocalGenerationFromTablet(2, now), false)
  assert.equal(await mod.takeLocalGenerationFromTablet(2, now), false)

  // Использовано ровно столько, сколько приняли.
  assert.equal(await mod.tabletDailyUsed(now), 2)
})

test('счётчик переживает перезапуск (новый импорт) и помнит день', async () => {
  const first = await freshModule()
  const now = new Date('2026-10-06T09:00:00')
  assert.equal(await first.takeLocalGenerationFromTablet(3, now), true)
  assert.equal(await first.takeLocalGenerationFromTablet(3, now), true)

  // «Перезапуск сервера» — тот же файл читает свежий модуль.
  const second = await freshModule()
  assert.equal(await second.tabletDailyUsed(now), 2)
  assert.equal(await second.takeLocalGenerationFromTablet(3, now), true)
  assert.equal(await second.takeLocalGenerationFromTablet(3, now), false)
})

test('в полночь по локальной дате счётчик обнуляется', async () => {
  const mod = await freshModule()

  const day1 = new Date('2026-10-07T23:50:00')
  assert.equal(await mod.takeLocalGenerationFromTablet(1, day1), true)
  assert.equal(await mod.takeLocalGenerationFromTablet(1, day1), false)
  assert.equal(await mod.tabletDailyUsed(day1), 1)

  // Первые секунды следующего дня — уже новый день, лимит снова доступен.
  const day2 = nextDayMidnight(day1)
  assert.equal(await mod.tabletDailyUsed(day2), 0)
  assert.equal(await mod.takeLocalGenerationFromTablet(1, day2), true)
})