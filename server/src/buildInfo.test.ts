import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BUILD_INFO_FILE, formatBuildLine, readBuildInfo } from './buildInfo.js'

/**
 * Номер сборки (пункт 5.1): у покупателя его даёт файл поставки, у
 * разработчика — git, а без обоих — честное «неизвестна», а не выдумка.
 */

async function folder(t: test.TestContext, files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-build-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}))
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content)
  return dir
}

const noGit = () => { throw new Error('git здесь не нужен') }

test('файл поставки важнее git: у покупателя .git нет вовсе', async (t) => {
  const dir = await folder(t, {
    'package.json': '{"version":"1.2.3"}',
    [BUILD_INFO_FILE]: '{"commit":"0123456789ab","date":"2026-09-26T12:00:00+03:00"}',
  })
  assert.deepEqual(readBuildInfo(dir, noGit), {
    version: '1.2.3', commit: '0123456789ab', date: '2026-09-26T12:00:00+03:00',
  })
})

test('без файла номер берётся у git, незакоммиченные правки видны', async (t) => {
  const dir = await folder(t, { 'package.json': '{"version":"0.1.0"}' })
  const answers: Record<string, string> = {
    'rev-parse': 'abcdef012345',
    log: '2026-09-26T14:52:07+03:00',
    diff: 'server/src/index.ts',
  }
  const git = (args: string[]) => answers[args[0]!] ?? ''
  assert.deepEqual(readBuildInfo(dir, git), {
    version: '0.1.0', commit: 'abcdef012345', date: '2026-09-26T14:52:07+03:00', dirty: true,
  })
  answers.diff = ''
  assert.equal(readBuildInfo(dir, git).dirty, undefined, 'чистая папка — без пометки')
})

function realGit(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
}

test('заново записанный файл с теми же байтами — не правка, даже когда git зовёт его изменённым', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
  } catch {
    t.skip('git недоступен')
    return
  }
  // Как у make-dist: копия выписана с CRLF (autocrlf=true), а генератор
  // лицензий перезаписал файл теми же строками, но с LF.
  const lines = 'MIT License\nCopyright\n'
  const dir = await folder(t, { 'package.json': '{"version":"0.1.0"}\n', 'LICENSES.txt': lines })
  realGit(dir, ['init', '-q'])
  realGit(dir, ['config', 'core.autocrlf', 'true'])
  realGit(dir, ['add', '.'])
  realGit(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  await fs.rm(path.join(dir, 'LICENSES.txt'))
  realGit(dir, ['checkout', '--', 'LICENSES.txt'])
  await fs.writeFile(path.join(dir, 'LICENSES.txt'), lines)

  assert.equal(readBuildInfo(dir).dirty, undefined, 'содержимое совпадает с коммитом — сборка чистая')
  await fs.appendFile(path.join(dir, 'LICENSES.txt'), 'правка\n')
  assert.equal(readBuildInfo(dir).dirty, true, 'настоящая правка по-прежнему видна')
  realGit(dir, ['add', 'LICENSES.txt'])
  assert.equal(readBuildInfo(dir).dirty, true, 'правка в индексе — тоже правка')
})

test('негодный файл не выдаётся за номер, а без git — честное «неизвестна»', async (t) => {
  const dir = await folder(t, {
    'package.json': '{"version":"0.1.0"}',
    [BUILD_INFO_FILE]: '{"commit":"не номер"}',
  })
  assert.deepEqual(readBuildInfo(dir, () => ''), { version: '0.1.0', commit: null, date: null })
  assert.equal(formatBuildLine(readBuildInfo(dir, () => '')), 'CanAI 0.1.0 · build unknown')
})

test('строка журнала говорит версию, номер и дату', () => {
  assert.equal(
    formatBuildLine({ version: '0.1.0', commit: '7aa625f3bbb9', date: '2026-09-26T14:52:07+03:00' }),
    `CanAI 0.1.0 · build 7aa625f3bbb9 from ${new Date('2026-09-26T14:52:07+03:00').getDate().toString().padStart(2, '0')}.09.2026`,
  )
  assert.match(
    formatBuildLine({ version: '0.1.0', commit: '7aa625f3bbb9', date: null, dirty: true }),
    /^CanAI 0\.1\.0 · build 7aa625f3bbb9 \(with uncommitted changes\)$/,
  )
})
