import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Перенос данных из прежней версии (пункт 5.4 списка исправлений).
 *
 * Для непрограммиста ручной перенос `server/data` и ключа — самый вероятный
 * способ потерять доски. Скрипт обязан: перенести всё и сверить; ничего не
 * удалить (прежняя папка — единственная страховка); отложить то, что уже было
 * в новой папке, а не стереть; и отказать СЛОВАМИ, ничего не тронув, если
 * прежняя версия не останавливается или выбрана не та папка.
 */

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const windowsOnly = { skip: process.platform !== 'win32' }

async function write(base, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(base, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
}

async function fixture(t, { oldFiles = {}, newFiles = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'canai-migrate-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}))
  const oldRoot = path.join(dir, 'CanAI прежняя')
  const newRoot = path.join(dir, 'CanAI новая')
  await write(oldRoot, {
    'Start CanAI.bat': '@echo off',
    'server/data/projects.json': JSON.stringify([{ id: 'a' }, { id: 'b' }]),
    'server/data/projects/a/project.json': '{"items":[]}',
    'server/data/media/общее/кадр.png': Buffer.alloc(4096, 7),
    'server/data/logs/server.log': 'журнал',
    'server/data/runtime-control.json': '{"version":1,"port":8787}',
    'server/.env': 'FAL_KEY=synthetic-old-key\n',
    ...oldFiles,
  })
  await write(newRoot, {
    'Start CanAI.bat': '@echo off',
    ...newFiles,
  })
  await fs.copyFile(path.join(root, 'migrate-data.ps1'), path.join(newRoot, 'migrate-data.ps1'))
  // Кириллица в выводе: консоль PowerShell по умолчанию пишет в кодовой
  // странице системы, а проверка читает UTF-8.
  const wrapper = path.join(dir, 'run.ps1')
  await fs.writeFile(wrapper, `﻿param([string]$Script, [string]$From)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
& $Script -From $From -Yes
exit $LASTEXITCODE
`)
  const run = async (from) => {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
        '-Script', path.join(newRoot, 'migrate-data.ps1'), '-From', from,
      ], { windowsHide: true, timeout: 60_000, encoding: 'utf8' })
      return { code: 0, out: stdout }
    } catch (error) {
      return { code: error.code, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  }
  return { oldRoot, newRoot, run }
}

const exists = (file) => fs.access(file).then(() => true, () => false)

test('перенос: доски, файлы и ключ на месте, прежняя папка цела, своё отложено', windowsOnly, async (t) => {
  const { oldRoot, newRoot, run } = await fixture(t, {
    newFiles: {
      // Пробный запуск новой версии уже завёл пустую доску и ключ.
      'server/data/projects.json': JSON.stringify([{ id: 'пустая' }]),
      'server/.env': 'FAL_KEY=synthetic-new-key\n',
    },
  })
  const result = await run(oldRoot)
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /Done: copied boards 2, files 4/)

  const data = path.join(newRoot, 'server', 'data')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'projects.json'), 'utf8')), [{ id: 'a' }, { id: 'b' }])
  assert.equal((await fs.readFile(path.join(data, 'media', 'общее', 'кадр.png'))).length, 4096)
  assert.equal(await fs.readFile(path.join(newRoot, 'server', '.env'), 'utf8'), 'FAL_KEY=synthetic-old-key\n')
  assert.equal(await exists(path.join(data, 'runtime-control.json')), false,
    'файл управления прежним сервером в новую копию не переезжает')

  // Своё не стёрто, а отложено рядом.
  const server = await fs.readdir(path.join(newRoot, 'server'))
  const setAside = server.find((name) => name.startsWith('data-before-migration-'))
  assert.ok(setAside, `данные новой версии отложены: ${server.join(', ')}`)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(newRoot, 'server', setAside, 'projects.json'), 'utf8')), [{ id: 'пустая' }])
  assert.ok(server.some((name) => name.startsWith('.env-before-migration-')), 'ключ новой версии отложен')

  // Прежняя папка — единственная страховка, и она цела.
  assert.ok(await exists(path.join(oldRoot, 'server', 'data', 'runtime-control.json')))
  assert.ok(await exists(path.join(oldRoot, 'server', 'data', 'media', 'общее', 'кадр.png')))
  assert.ok(await exists(path.join(oldRoot, 'server', '.env')))
})

test('не та папка — отказ словами, в новой версии ничего не тронуто', windowsOnly, async (t) => {
  const { newRoot, run } = await fixture(t, {
    newFiles: { 'server/data/projects.json': '[]' },
  })
  const empty = path.join(path.dirname(newRoot), 'просто папка')
  await fs.mkdir(empty)
  const wrong = await run(empty)
  assert.equal(wrong.code, 1, wrong.out)
  assert.match(wrong.out, /has no CanAI boards/)
  const self = await run(newRoot)
  assert.equal(self.code, 1, self.out)
  assert.match(self.out, /The NEW folder was selected/)
  assert.deepEqual(await fs.readdir(path.join(newRoot, 'server')), ['data'], 'ничего не отложено и не скопировано')
})

test('прежняя версия не останавливается — перенос не начинается', windowsOnly, async (t) => {
  const { oldRoot, newRoot, run } = await fixture(t, {
    // stop.ps1 прежней версии отвечает «не смог»: сервер жив и пишет доску.
    oldFiles: { 'stop.ps1': "﻿Write-Host '[CanAI] Ничего не было остановлено.'\nexit 1\n" },
    newFiles: { 'server/data/projects.json': '[]' },
  })
  const result = await run(oldRoot)
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /could not be stopped/)
  assert.deepEqual(await fs.readdir(path.join(newRoot, 'server')), ['data'], 'пока прежняя жива, новая не тронута')
})
