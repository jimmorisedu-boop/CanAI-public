import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'

test('AgentHost starts a native-ref generation package with the captured board artifact', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-host-generation-'))
  process.env.CANAI_DATA_DIR = dataDir
  process.env.CANAI_ENV_FILE = path.join(dataDir, 'none.env')
  t.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }))

  const { config } = await import('../config.js')
  const { createProject, ensureProjects } = await import('../projects.js')
  const { AgentTaskJournal } = await import('./journal.js')
  const { AgentPackageRegistry } = await import('./packages.js')
  const { AgentProtocolValidator } = await import('./validation.js')
  const { AgentHost } = await import('./host.js')
  const { AgentToolBroker } = await import('./tools.js')
  const { AgentGenerationBroker } = await import('./generation-broker.js')
  const { captureGenerationInputs } = await import('./generation-input-capture.js')
  const { digest } = await import('./generation-broker-helpers.js')

  const root = await fs.mkdtemp(path.join(dataDir, 'fixture-'))
  const workspaceRoot = path.join(root, 'workspace')
  const packageRoot = path.join(root, 'packages')
  const packageDir = path.join(packageRoot, 'generation-fixture')
  const schemaDir = fileURLToPath(new URL('../../../docs/agents', import.meta.url))
  const packageScript = `
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'

const taskId = process.env.CANAI_AGENT_TASK_ID
const executionId = process.env.CANAI_AGENT_EXECUTION_ID
let sequence = 0
let grantId = ''
let refs = []
let finished = false

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => JSON.stringify(key) + ':' + stableJson(nested)).join(',') + '}'
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function send(type, payload) {
  process.stdout.write(JSON.stringify({ protocolVersion: '1.0', messageId: 'fixture-' + (++sequence), taskId, executionId, type, payload }) + '\\n')
}

send('hello', { supportedProtocolVersions: ['1.0'], capabilities: ['structuredReviews', 'toolBroker'] })
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'task.start') {
    const grant = message.payload?.grants?.find((candidate) => candidate.tools?.includes('generation.request'))
    grantId = String(grant?.id ?? '')
    refs = Array.isArray(grant?.artifactRefs) ? grant.artifactRefs : []
    send('review.request', {
      reviewId: 'native-generation-review', revision: 1, stageId: 'generation',
      title: 'Native generation', question: 'Approve native generation', materials: [],
      decisions: ['approved', 'changes-requested', 'rejected'],
      generationSpec: {
        kind: 'image', modelId: 'image-edit-fixture', catalogRevision: 3,
        promptHash: digest('native edit'), refs,
        paramsHash: digest({ image_size: 'auto' }), prompt: 'native edit',
        params: { image_size: 'auto' }, estimateMicros: 10_000,
      },
    })
  }
  if (message.type === 'review.decision' && message.payload?.decision === 'approved' && !finished) {
    send('tool.request', {
      operationId: 'generation-native-1', tool: 'generation.request', arguments: {
        connectionId: 'local-fal', grantId, kind: 'image', prompt: 'native edit', refs,
        params: { image_size: 'auto' }, modelId: 'image-edit-fixture',
      },
    })
  }
  if (message.type === 'tool.result' && message.payload?.operationId === 'generation-native-1' && message.payload?.status === 'succeeded') {
    finished = true
    const artifacts = message.payload?.result?.artifacts
    send('task.finished', {
      outcome: 'succeeded', summary: 'Native generation finished',
      artifactIds: Array.isArray(artifacts) ? artifacts.map((artifact) => artifact.artifactId) : [],
    })
    setImmediate(() => process.exit(0))
  }
})
`

  await ensureProjects()
  await fs.mkdir(config.mediaDir, { recursive: true })
  await fs.mkdir(packageDir, { recursive: true })
  await fs.writeFile(path.join(config.mediaDir, 'selected.png'), Buffer.from('selected-native-image-v1'))
  await fs.writeFile(path.join(packageDir, 'input.json'), JSON.stringify({ type: 'object', additionalProperties: false }))
  await fs.writeFile(path.join(packageDir, 'index.mjs'), packageScript)
  await fs.writeFile(path.join(packageDir, 'canai.agent.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'generation.fixture',
    name: 'Native generation fixture',
    description: 'Offline package for native generation refs',
    version: '1.0.0',
    protocolVersion: '1.0',
    runtime: { kind: 'node', version: '20.0', entrypoint: { kind: 'file', path: 'index.mjs' }, dependencies: { kind: 'stdlib' }, maxParallelTasks: 1 },
    taskTypes: [{ id: 'generate-image', label: 'Generate image', description: 'One native image attempt', inputSchema: 'input.json', outputKinds: ['image'] }],
    permissions: ['generation.request', 'review.request'],
    connections: [{ id: 'local-fal', label: 'Local fal', kind: 'generation', required: true }],
    lifecycle: { pause: 'checkpoint', resume: true, cancel: true },
  }))

  const selected = Buffer.from('selected-native-image-v1')
  const project = await createProject('Native generation fixture', {
    version: 1,
    items: [{ id: 'item-native', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: '/media/selected.png', name: 'Selected native', mime: 'image/png' }],
    camera: { x: 0, y: 0, scale: 1 },
  })
  const projectRef = { source: 'local' as const, id: project.id }

  const catalogModel: CatalogModel = {
    id: 'image-edit-fixture', name: 'Image edit fixture', kind: 'image', endpoint: 'fake/image-edit',
    refs: true, inputModalities: ['image'], maxImageRefs: 1, maxTotalRefs: 1, lifecycle: 'active',
    pricing: { unit: 'image', usd: 0.01 },
    params: [{ name: 'image_size', label: 'Image size', widget: 'select', default: 'auto', options: [{ value: 'auto', label: 'Auto' }] }],
  }
  const job = {
    id: 'job-native-1', status: 'done' as const,
    result: { url: '/media/generated-native.png', mime: 'image/png' },
    chargedAmountUsd: 0.01, falRequestId: 'fal-native-1',
  }
  const observed: Array<{ refs: Array<{ src: string; kind: string }>; model: CatalogModel; params: Record<string, unknown> }> = []
  const runner = {
    async create(input: { refs: Array<{ src: string; kind: string }>; model: CatalogModel; params: Record<string, unknown> }) {
      observed.push(structuredClone(input))
      await fs.writeFile(path.join(config.mediaDir, 'generated-native.png'), Buffer.from('generated-native-image-v1'))
      return { jobId: job.id }
    },
    get() { return structuredClone(job) },
    async cancel() {},
  }
  const journal = new AgentTaskJournal(path.join(root, 'agent-tasks.json'), { workspaceRoot, checkpointRoot: path.join(root, 'checkpoints') })
  const generation = new AgentGenerationBroker({
    journal,
    catalog: { models: () => [catalogModel], view: () => ({ revision: 3 }) },
    mediaDir: config.mediaDir, provider: runner, connectionReady: () => true, pollMs: 1,
  })
  const validator = new AgentProtocolValidator(schemaDir)
  const packages = new AgentPackageRegistry(validator, packageRoot)
  await packages.loadBundled()
  const broker = new AgentToolBroker({ mediaDir: config.mediaDir, workspaceRoot, generation })
  const host = new AgentHost({ journal, packages, broker, workspaceRoot, mediaDir: config.mediaDir, validator })
  t.after(async () => { await host.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) })

  const receipts = await captureGenerationInputs({ projectRef, projectRevision: 1, inputs: [{ itemId: 'item-native', kind: 'image' }] }, config.mediaDir)
  const artifact = receipts[0]!.artifact
  const checksum = crypto.createHash('sha256').update(selected).digest('hex')
  assert.equal(artifact.checksum, checksum)
  const refs = [{ artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum }]
  const created = await host.create({
    requestId: 'native-host-generation-request', packageId: 'generation.fixture', taskType: 'generate-image',
    instruction: 'Generate the selected image', input: {}, projectRef,
    inputs: [{ itemId: 'item-native', artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum, kind: 'image', caption: artifact.caption }],
    capturedArtifacts: receipts,
    generation: {
      connectionId: 'local-fal', mediaTransferConsent: true, maxCostMicros: 20_000, maxCalls: 1,
      expectedModelId: catalogModel.id, expectedCatalogRevision: 3, artifactRefs: refs,
    },
  })

  async function waitFor(predicate: (value: Awaited<ReturnType<typeof host.get>>) => boolean): Promise<NonNullable<Awaited<ReturnType<typeof host.get>>>> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const value = await host.get(created.taskId)
      if (value && predicate(value)) return value
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('native generation Host integration timed out')
  }

  let task = await waitFor((value) => Boolean(value?.reviews.some((review) => review.status === 'pending')))
  const review = task.reviews.find((candidate) => candidate.status === 'pending')!
  task = await host.decide(created.taskId, review.reviewId, {
    requestId: 'native-host-generation-approve', expectedRevision: task.revision, revision: review.revision,
    decision: 'approved', comment: '', answers: {},
  })
  task = await waitFor((value) => value?.state === 'succeeded')

  assert.equal(observed.length, 1)
  assert.equal(observed[0]!.model.id, catalogModel.id)
  assert.deepEqual(observed[0]!.params, { image_size: 'auto' })
  assert.deepEqual(observed[0]!.refs, [{ kind: 'image', src: artifact.mediaSrc, role: undefined }])
  assert.equal(task.artifacts.some((entry) => entry.provenance === 'generated'), true)
})
