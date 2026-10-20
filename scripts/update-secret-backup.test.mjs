import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PUBLIC_SOURCE_FORMAT, PUBLIC_SOURCE_VERSION } from './public-release-config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function isGeneratedPublicSnapshotWithoutUpdater(sourceRoot) {
  const manifestPath = path.join(sourceRoot, 'PUBLIC-SOURCE-MANIFEST.json')
  if (!existsSync(manifestPath) || existsSync(path.join(sourceRoot, 'update.ps1')) || existsSync(path.join(sourceRoot, 'Update CanAI.bat'))) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const files = manifest?.files
    if (manifest?.format !== PUBLIC_SOURCE_FORMAT || manifest?.version !== PUBLIC_SOURCE_VERSION || !Array.isArray(files) || files.length === 0) return false
    if (!files.every((entry) => entry && typeof entry.path === 'string' && typeof entry.mode === 'string' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[0-9a-f]{64}$/u.test(String(entry.sha256)))) return false
    const paths = new Set(files.map((entry) => entry.path))
    return !paths.has('update.ps1') && !paths.has('Update CanAI.bat')
  } catch {
    return false
  }
}

const publicSnapshotWithoutUpdater = isGeneratedPublicSnapshotWithoutUpdater(root)

test('developer git updater clears archive build metadata before reporting success', {
  skip: publicSnapshotWithoutUpdater,
}, () => {
  const update = readFileSync(path.join(root, 'update.ps1'), 'utf8')
  const done = update.indexOf("Write-Host '[update] Done - you are on the latest version.'")
  const cleanup = update.indexOf("Join-Path $root 'build-info.json'")
  assert.ok(cleanup > 0 && cleanup < done, 'the old archive build number must be cleared on every git update')
})

function runUpdater(script, cwd, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
    ], {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`update.ps1 exited with ${code}\n${stdout}\n${stderr}`))
    })
    child.stdin.end('y\r\n')
  })
}

test('updater backup cannot move a FAL key into another portable copy', {
  // The public source snapshot intentionally omits the developer-only updater.
  // Keep the test active in the authoring checkout so an accidental omission
  // there still fails instead of being hidden by a broad skip.
  skip: process.platform !== 'win32' || publicSnapshotWithoutUpdater,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-update-secret-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))

  const temporary = path.join(directory, 'temp')
  const fakeBin = path.join(directory, 'bin')
  const installA = path.join(directory, 'CanAI-A')
  const installB = path.join(directory, 'CanAI-B')
  await Promise.all([
    fs.mkdir(temporary, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(path.join(installA, 'server'), { recursive: true }),
    fs.mkdir(path.join(installB, 'server'), { recursive: true }),
  ])
  await fs.writeFile(path.join(fakeBin, 'git.cmd'), '@echo off\r\nexit /b 0\r\n', 'ascii')
  await Promise.all([
    fs.copyFile(path.join(root, 'update.ps1'), path.join(installA, 'update.ps1')),
    fs.copyFile(path.join(root, 'update.ps1'), path.join(installB, 'update.ps1')),
  ])

  const keyA = 'FAL_KEY=test-key-from-installation-a\n'
  await fs.writeFile(path.join(installA, 'server', '.env'), keyA, 'utf8')
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  const environment = {
    ...process.env,
    TEMP: temporary,
    TMP: temporary,
    [pathKey]: `${fakeBin};${process.env[pathKey] ?? ''}`,
  }

  await runUpdater(path.join(installA, 'update.ps1'), installA, environment)
  await runUpdater(path.join(installB, 'update.ps1'), installB, environment)

  assert.equal(await fs.readFile(path.join(installA, 'server', '.env'), 'utf8'), keyA)
  assert.deepEqual(
    (await fs.readdir(path.join(installA, 'server', 'data'))).filter((name) => name.startsWith('.env.update-')),
    [],
    'успешное обновление не должно оставлять временную копию ключа',
  )
  await assert.rejects(
    () => fs.stat(path.join(installB, 'server', '.env')),
    { code: 'ENOENT' },
    'копия без собственного ключа не должна получить backup другой установки',
  )
})
