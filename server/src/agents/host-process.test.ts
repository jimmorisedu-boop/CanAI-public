import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentProcessManager } from './host-process.js'
import type { AgentPackage } from './packages.js'

test('process manager uses the reverified pinned launch instead of reconstructing Node argv', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-process-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }))
  let line = ''
  let exit: Promise<void>
  let resolveExit!: () => void
  exit = new Promise<void>((resolve) => { resolveExit = resolve })
  const manager = new AgentProcessManager({
    onLine: (_taskId, _managed, value) => { line = value },
    onExit: async () => { resolveExit() },
    onProtocolOverflow: async () => { resolveExit() },
  })
  t.after(() => manager.close())
  const entrypoint = path.join(root, 'this-entrypoint-must-not-run.mjs')
  manager.spawnProcess({
    taskId: 'launch-dispatch',
    package: { entrypoint } as AgentPackage,
    executionId: 'execution-launch-dispatch',
    cwd: root,
    env: { NODE_ENV: 'test' },
    // The kind is intentionally python-shaped while using the current Node
    // executable as a harmless test transport. The assertion is about exact
    // launch propagation; production computes this object only via
    // pythonLaunch after a verified portable-runtime receipt.
    launch: { kind: 'python', executable: process.execPath, args: ['-e', 'process.stdout.write("pinned-launch\\n")'] },
  })
  await exit
  assert.equal(line, 'pinned-launch')
})
