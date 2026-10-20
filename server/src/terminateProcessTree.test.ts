import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { nothingToKill, taskkillArgs, terminateProcessTree } from './terminateProcessTree.js'

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Дочерний процесс не перешёл в ожидаемое состояние')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('отмена загрузчика завершает его настоящее дочернее дерево', { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-verify-process-tree-'))
  const marker = path.join(directory, 'descendant.pid')
  const descendantScript = path.join(directory, 'descendant.mjs')
  const parentScript = path.join(directory, 'parent.mjs')
  await fs.writeFile(descendantScript, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(), 15000);")
  await fs.writeFile(parentScript, "import {spawn} from 'node:child_process'; spawn(process.execPath, process.argv.slice(2), {windowsHide:true,stdio:'ignore'}); setInterval(() => {}, 1000); setTimeout(() => process.exit(), 15000);")
  const child = spawn(process.execPath, [parentScript, descendantScript, marker], { windowsHide: true, stdio: 'ignore' })
  let descendant = 0
  try {
    await until(async () => { descendant = Number(await fs.readFile(marker, 'utf8').catch(() => '0')); return descendant > 0 })
    assert.equal(alive(child.pid!), true)
    assert.equal(alive(descendant), true)
    await terminateProcessTree(child)
    await until(() => !alive(child.pid!))
    await until(() => !alive(descendant))
    assert.equal(alive(descendant), false, 'после отмены дочерний загрузчик всё ещё работает')
  } finally {
    // Only IDs launched above; /T also cleans the tree when an assertion fails.
    for (const pid of [child.pid, descendant]) {
      if (pid && alive(pid)) {
        if (process.platform === 'win32') {
          await new Promise<void>((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
        } else {
          try { process.kill(pid, 'SIGKILL') } catch {}
        }
      }
    }
    const resolved = path.resolve(directory)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(resolved).startsWith('canai-verify-process-tree-'))
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

/**
 * ⚠️ Номер процесса Windows переиспользует. Между выходом дочернего и тем
 * мигом, когда Node это заметит, номер может достаться ЧУЖОМУ процессу — и
 * `taskkill /T /F` снёс бы чужое дерево, например оболочку лаунчера. Тогда у
 * сервера пропадает консоль, он получает SIGHUP и уходит, а окно остаётся
 * открытым — ровно то, на что жаловались 20.09.2026.
 */
test('удар по дереву ограничен именем НАШЕЙ программы', () => {
  assert.deepEqual(
    taskkillArgs(1234, 'C:/CanAI/runtime/media-tools/yt-dlp.exe'),
    ['/PID', '1234', '/T', '/F', '/FI', 'IMAGENAME eq yt-dlp.exe'],
  )
  // Имени нет — бьём как раньше: лучше так, чем не завершить скачивание вовсе.
  assert.deepEqual(taskkillArgs(7, undefined), ['/PID', '7', '/T', '/F'])
})

test('«нет таких задач» — это не сбой', () => {
  // Так taskkill отвечает, когда фильтр нас уберёг или процесс ушёл сам.
  assert.equal(nothingToKill('INFO: No tasks running with the specified criteria.'), true)
  assert.equal(nothingToKill('ИНФО: не выполняются задачи с указанными критериями.'), true)
  assert.equal(nothingToKill('ERROR: Access is denied.'), false)
})
