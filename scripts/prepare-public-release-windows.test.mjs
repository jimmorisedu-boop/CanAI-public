import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { defaultCommandRunner } from './prepare-public-release-steps.mjs'

test('release child PowerShell discovers its own modules when launched through Node', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-release-shell-test-'))
  const file = path.join(directory, 'fixture.txt')
  const logPath = path.join(directory, 'child.log')
  t.after(async () => {
    for (const target of [file, logPath]) await fs.unlink(target).catch((error) => { if (error.code !== 'ENOENT') throw error })
    await fs.rmdir(directory)
  })
  const content = 'release verification\n'
  await fs.writeFile(file, content)
  const result = await defaultCommandRunner({
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; (Get-FileHash -LiteralPath $env:CANAI_RELEASE_HASH_FILE -Algorithm SHA256).Hash'],
    cwd: directory,
    env: { ...process.env, CANAI_RELEASE_HASH_FILE: file },
    logPath,
  })
  assert.equal(result.code, 0, result.output)
  assert.equal(result.output.trim().toLowerCase(), createHash('sha256').update(content).digest('hex'))
})
