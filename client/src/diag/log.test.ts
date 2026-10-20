import assert from 'node:assert/strict'
import test from 'node:test'
import { clearLog, dumpLogText, getLogEntries, log, logEvent } from './log.js'
import { sanitizeLogValue } from './logSanitize.js'

test('журнал копится сам, без включения, и не растёт бесконечно', () => {
  clearLog()
  for (let i = 0; i < 1600; i += 1) logEvent('debug', 'gen', `шаг ${i}`)
  const entries = getLogEntries()
  assert.ok(entries.length <= 1500, `кольцо не должно расти: ${entries.length}`)
  assert.equal(entries.at(-1)?.event, 'шаг 1599', 'последние записи обязаны сохраниться')
  assert.ok(!entries.some((entry) => entry.event === 'шаг 0'), 'самые старые вытесняются')
})

test('в журнал не попадают ни base64, ни секреты, ни простыни', () => {
  const clean = sanitizeLogValue({
    src: `data:image/png;base64,${'A'.repeat(50_000)}`,
    falKey: 'секрет-который-нельзя-пересылать',
    accessToken: 'abc',
    prompt: 'п'.repeat(1000),
    ok: true,
  }) as Record<string, string>
  assert.ok(clean.src.startsWith('data:image/png;base64,…'), clean.src)
  assert.ok(clean.src.length < 60, 'картинка обязана схлопнуться в одну строку')
  assert.equal(clean.falKey, '[hidden]')
  assert.equal(clean.accessToken, '[hidden]')
  assert.ok(clean.prompt.length < 260, 'длинный промпт обрезается')
  assert.equal(clean.ok as unknown, true)
})

test('строка запроса у ссылки на медиа не засоряет журнал', () => {
  assert.equal(sanitizeLogValue('/media/кадр.png?v=1712345678901'), '/media/кадр.png?…')
})

test('запись в журнал не бросает ни на чём', () => {
  clearLog()
  const loop: Record<string, unknown> = { name: 'сам на себя' }
  loop.self = loop
  assert.doesNotThrow(() => log.error('cloud', 'правка отклонена', loop))
  assert.doesNotThrow(() => log.info('net', 'ответ', undefined))
  assert.doesNotThrow(() => log.info('net', 'ответ', 42))
  assert.equal(getLogEntries().length, 3)
})

test('выгрузка читается глазами и содержит событие с данными', () => {
  clearLog()
  log.error('cloud', 'правка отклонена', { code: 'invalid', reason: 'Недопустимый jobId pending' })
  const text = dumpLogText({ Доска: 'prj_1' })
  assert.match(text, /CanAI log/)
  assert.match(text, /Доска: prj_1/)
  assert.match(text, /ERROR/)
  assert.match(text, /правка отклонена/)
  assert.match(text, /Недопустимый jobId pending/)
})
