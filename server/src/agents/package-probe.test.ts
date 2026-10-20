import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { AGENT_MAX_MESSAGE_BYTES } from '../../../packages/agent-protocol/index.js'
import { createDefaultPackageProbe } from './package-probe.js'
import { AgentProtocolValidator } from './validation.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(source: string): Promise<{ root: string; entrypoint: string; workspace: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-probe-'))
  roots.push(root)
  const entrypoint = path.join(root, 'index.mjs')
  const workspace = path.join(root, 'probe-workspace')
  await fs.writeFile(entrypoint, source, 'utf8')
  return { root, entrypoint, workspace }
}

const validSource = `const message = { protocolVersion: '1.0', messageId: 'probe-message', taskId: 'probe', executionId: process.env.CANAI_AGENT_EXECUTION_ID, type: 'hello', payload: { supportedProtocolVersions: ['1.0'], capabilities: ['resume'] } }; process.stdout.write(JSON.stringify(message) + '\\n'); setInterval(() => {}, 1000);`

describe('bounded package hello probe', () => {
  it('accepts matching hello and tears down a still-running process', async () => {
    const input = await fixture(validSource)
    const result = await createDefaultPackageProbe(new AgentProtocolValidator())({ ...input, installationId: 'probe-install', expectedCapabilities: ['resume'] })
    assert.equal(result.hello.type, 'hello')
    await assert.rejects(fs.stat(input.workspace))
  })

  it('rejects nohello, mismatched identity and oversized output', async () => {
    const noHello = await fixture('process.exit(0)')
    await assert.rejects(createDefaultPackageProbe()({ ...noHello, installationId: 'probe-nohello' }), { code: 'PROBE_FAILED' })
    const mismatch = await fixture(validSource.replace("executionId: process.env.CANAI_AGENT_EXECUTION_ID", "executionId: 'wrong'"))
    await assert.rejects(createDefaultPackageProbe()({ ...mismatch, installationId: 'probe-mismatch' }), { code: 'PROBE_PROTOCOL_INVALID' })
    const oversized = await fixture(`process.stdout.write('x'.repeat(${AGENT_MAX_MESSAGE_BYTES + 1}) + '\\n')`)
    await assert.rejects(createDefaultPackageProbe()({ ...oversized, installationId: 'probe-big' }), { code: 'PROBE_OUTPUT_TOO_LARGE' })
  })
})
