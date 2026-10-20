// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import path from 'node:path'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { fileURLToPath } from 'node:url'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import {
  JOB_FAILED,
  JOB_LOST,
  JOB_NO_CONNECTION,
  JOB_TIMED_OUT,
  MAX_CONSECUTIVE_ERRORS,
  POLL_MS,
  jobDeadlineMs,
} from './jobPolling'

test('видео ждём дольше картинки, и потолок есть у обоих', () => {
  assert.ok(jobDeadlineMs('video') > jobDeadlineMs('image'))
  assert.ok(jobDeadlineMs('image') > 60_000, 'минуты мало даже для картинки')
})

test('порог «связи нет» измеряется десятками секунд, а не одним промахом', () => {
  assert.ok(MAX_CONSECUTIVE_ERRORS * POLL_MS > 20_000)
})

// Опросчиков два намеренно (реестр ведёт пачку, generateAndWait ждёт одну
// задачу для движка нод). Но формулировки — это то, что читает пользователь, и
// в двух местах они уже начинали жить своей жизнью: «задача не нашлась на
// сервере» против «задача потерялась после перезапуска сервера» об одном и том
// же 404.
test('оба опросчика говорят одними и теми же словами', () => {
  const root = path.resolve(fileURLToPath(import.meta.url), '../../..')
  const messages = [JOB_FAILED, JOB_LOST, JOB_NO_CONNECTION, JOB_TIMED_OUT]
  const offenders: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue
      // сам модуль эти строки и объявляет
      if (entry.name === 'jobPolling.ts') continue
      const source = readFileSync(full, 'utf8')
      for (const message of messages) {
        if (source.includes(`'${message}'`)) {
          offenders.push(`${path.relative(root, full)}: ${message}`)
        }
      }
    }
  }
  walk(root)

  assert.deepEqual(offenders, [], `формулировка задана мимо jobPolling: ${offenders.join(' | ')}`)
})
