/**
 * Isolated live proof for the local native-media Agent flow.
 *
 * This is intentionally a fixture entrypoint, never a production flag.  It
 * refuses to start unless CANAI_MOCK=1 and the caller supplied a fresh
 * CANAI_ENV_FILE inside a canai-verify-* temp directory.  The fixture uses a
 * real AgentHost, package protocol, capture route, review route, journal and
 * project API, while injecting deterministic in-process LLM and generation
 * adapters.  No provider network calls are possible from this entrypoint.
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { Router } from 'express'
import type { CatalogModel } from '../../../packages/model-catalog/catalog.js'
import type { AgentGenerationJobRunner } from './generation-broker.js'
import type { AgentLlmProvider, AgentLlmProviderResult } from './llm-broker.js'

interface FixtureEnv {
  dataDir: string
  envFile: string
  port: number
}

interface FakeCall {
  taskId: string
  operationId: string
  prompt: string
  modelId: string
  params: Record<string, unknown>
  refs: Array<{ kind: 'image' | 'video' | 'audio'; src: string; role?: string }>
  jobId: string
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

async function listenOn(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function listenFirstFree(server: http.Server, start: number, end = 8899): Promise<number> {
  let lastError: unknown = null
  for (let port = start; port <= end; port += 1) {
    try {
      await listenOn(server, port)
      return port
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No free desktop fixture port found')
}

/**
 * The fixture exercises the shipped Creator package with deterministic local
 * adapters.  This is intentionally an injected provider, not a production
 * mock path: the live entrypoint refuses to start outside CANAI_MOCK=1 and a
 * fresh verification directory.
 */
class FixtureLlmProvider implements AgentLlmProvider {
  submits = 0
  resumes = 0
  cancels = 0

  async submit(
    _model: CatalogModel,
    _messages: Array<{ role: 'system' | 'user' | 'assistant'; text: string }>,
    _maxTokens: number,
    onEnqueued: (requestId: string, endpoint: string) => Promise<void>,
  ): Promise<AgentLlmProviderResult> {
    this.submits += 1
    await onEnqueued(`live-fixture-llm-${this.submits}`, 'fixture/assistant')
    return {
      text: 'A single cinematic portrait based on the selected native material, soft studio light, natural detail.',
      usage: { inputTokens: 18, outputTokens: 19, costMicros: 1_500 },
    }
  }

  async resume(_model: CatalogModel, _requestId: string): Promise<AgentLlmProviderResult> {
    this.resumes += 1
    return {
      text: 'A single cinematic portrait based on the selected native material, soft studio light, natural detail.',
      usage: { inputTokens: 18, outputTokens: 19, costMicros: 1_500 },
    }
  }

  async cancel(): Promise<void> { this.cancels += 1 }
}

function requireFixtureEnv(): FixtureEnv {
  if (process.env.CANAI_MOCK !== '1') throw new Error('live-ui-fixture requires CANAI_MOCK=1')
  const dataDir = path.resolve(String(process.env.CANAI_DATA_DIR ?? ''))
  const tempRoot = path.resolve(os.tmpdir())
  if (!dataDir || dataDir === path.parse(dataDir).root || !dataDir.startsWith(`${tempRoot}${path.sep}`) || !path.basename(dataDir).startsWith('canai-verify-')) {
    throw new Error('CANAI_DATA_DIR must be a fresh %TEMP%\\canai-verify-* directory')
  }
  const envFile = path.resolve(String(process.env.CANAI_ENV_FILE ?? ''))
  if (!envFile || !envFile.startsWith(`${dataDir}${path.sep}`)) throw new Error('CANAI_ENV_FILE must be inside the fixture dataDir')
  const port = Number(process.env.PORT ?? 8795)
  if (!Number.isSafeInteger(port) || port < 8791 || port > 8899 || port === 8787) throw new Error('live-ui-fixture requires test loopback PORT 8791..8899')
  return { dataDir, envFile, port }
}

const SELECTED_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63789fe8f31f00067b029cb3325d6a0000000049454e44ae426082', 'hex')
const GENERATED_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63d0acb8f31f0004c8027df13b42b20000000049454e44ae426082', 'hex')
const FIXTURE_PIN = '2468'

async function main(): Promise<void> {
  const env = requireFixtureEnv()
  await fs.mkdir(env.dataDir, { recursive: true })
  if (await fs.access(env.envFile).then(() => true, () => false)) throw new Error('CANAI_ENV_FILE already exists; the fixture must be empty')

  const { config } = await import('../config.js')
  const { ensureMediaDir } = await import('../storage.js')
  const { ensureProjects, createProject, loadProjectSnapshot, saveProjectSnapshot } = await import('../projects.js')
  const { isCanvasSnapshot } = await import('../canvasSnapshot.js')
  const { missingCanvasMedia } = await import('../canvasMediaIntegrity.js')
  const { catalogLibrary, applyCatalogLibrary } = await import('../catalogLibrary.js')
  const { AgentTaskJournal } = await import('./journal.js')
  const { AgentPackageRegistry } = await import('./packages.js')
  const { AgentProtocolValidator } = await import('./validation.js')
  const { AgentHost } = await import('./host.js')
  const { AgentLlmBroker } = await import('./llm-broker.js')
  const { AgentToolBroker } = await import('./tools.js')
  const { AgentGenerationBroker } = await import('./generation-broker.js')
  const { createAgentRouter } = await import('./routes.js')
  const { apiRouter } = await import('../routes.js')
  const { attachMediaRoutes } = await import('../mediaRoute.js')
  const { createRemoteApp } = await import('../remoteApp.js')
  const { setRemoteEnabled, setRemotePin } = await import('../remoteAccess.js')
  const clientDist = fileURLToPath(new URL('../../../client/dist', import.meta.url))
  const tabletDist = path.join(clientDist, 'tablet')
  if (!(await fs.access(path.join(clientDist, 'index.html')).then(() => true, () => false))
    || !(await fs.access(path.join(tabletDist, 'tablet.html')).then(() => true, () => false))) {
    throw new Error('Build client/dist with tablet/tablet.html for the live UI fixture first')
  }

  await ensureMediaDir()
  await ensureProjects()
  await catalogLibrary.load()
  applyCatalogLibrary()
  await fs.writeFile(path.join(config.mediaDir, 'live-selected.png'), SELECTED_PNG)
  const project = await createProject('Live native generation proof', {
    version: 1,
    items: [{ id: 'live-selected-item', kind: 'image', x: 80, y: 80, w: 320, h: 240, src: '/media/live-selected.png', name: 'Selected native image', mime: 'image/png', naturalWidth: 320, naturalHeight: 240 }],
    camera: { x: 0, y: 0, scale: 1 },
  })

  const fixtureRoot = path.join(env.dataDir, 'fixture')
  const workspaceRoot = path.join(fixtureRoot, 'workspace')
  const checkpointRoot = path.join(fixtureRoot, 'checkpoints')
  await fs.mkdir(workspaceRoot, { recursive: true })

  const schemaDir = fileURLToPath(new URL('../../../docs/agents', import.meta.url))
  const validator = new AgentProtocolValidator(schemaDir)
  const bundledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bundled')
  const packages = new AgentPackageRegistry(validator, bundledRoot)
  await packages.loadBundled()

  const llmModel: CatalogModel = {
    // AgentLlmBroker admits only the shipped OpenRouter text endpoint. The
    // provider below is still an in-process deterministic injection, so this
    // catalog pin does not enable a network call.
    id: 'creator-assistant-fixture', name: 'Creator assistant fixture', kind: 'text' as const, endpoint: 'openrouter/router', lifecycle: 'active',
    defaults: { model: 'fixture/assistant' },
    textPricing: { inputPerMillion: 1, outputPerMillion: 1, checkedAt: '2026-10-05T00:00:00.000Z' },
    contextWindowTokens: 20_000,
  }
  const model: CatalogModel = {
    id: 'image-edit-fixture', name: 'Image edit fixture', kind: 'image' as const, endpoint: 'fixture/image-edit',
    refs: true, inputModalities: ['image'], maxImageRefs: 1, maxTotalRefs: 1, lifecycle: 'active',
    pricing: { unit: 'image', usd: 0.01 },
    params: [{ name: 'image_size', label: 'Image size', widget: 'select', default: 'auto', options: [{ value: 'auto', label: 'Auto' }] }],
  }
  const llmProvider = new FixtureLlmProvider()
  const calls: FakeCall[] = []
  const jobs = new Map<string, { id: string; status: 'done'; result: { url: string; mime: string }; chargedAmountUsd: number }>()
  const runner = {
    async create(input: Parameters<AgentGenerationJobRunner['create']>[0]): Promise<{ jobId: string }> {
      const jobId = `live-fake-job-${calls.length + 1}`
      const fileName = `${jobId}.png`
      await fs.writeFile(path.join(config.mediaDir, fileName), GENERATED_PNG)
      calls.push({ taskId: input.taskId, operationId: input.operationId, prompt: input.prompt, modelId: input.model.id, params: structuredClone(input.params), refs: structuredClone(input.refs), jobId })
      jobs.set(jobId, { id: jobId, status: 'done', result: { url: `/media/${fileName}`, mime: 'image/png' }, chargedAmountUsd: 0.01 })
      return { jobId }
    },
    get(jobId: string) { return jobs.get(jobId) },
    async cancel(_jobId: string): Promise<void> {},
  }
  const journal = new AgentTaskJournal(path.join(fixtureRoot, 'agent-tasks.json'), { workspaceRoot, checkpointRoot })
  const generation = new AgentGenerationBroker({
    journal, catalog: { models: () => [model], view: () => ({ revision: 7 }) }, mediaDir: config.mediaDir,
    provider: runner, connectionReady: () => true, mockMode: false, pollMs: 5,
  })
  const llm = new AgentLlmBroker({
    journal,
    catalog: { models: () => [llmModel], defaultModelId: () => llmModel.id, view: () => ({ revision: 7 }) },
    provider: llmProvider,
    connectionReady: () => true,
    mockMode: false,
  })
  const broker = new AgentToolBroker({ mediaDir: config.mediaDir, workspaceRoot, llm, generation })
  const host = new AgentHost({ journal, packages, broker, workspaceRoot, mediaDir: config.mediaDir, validator, ownerId: 'live-fixture-owner', controllerId: 'live-fixture-controller' })
  await host.restore()

  // Use the production LAN app for host checks, PIN login, HttpOnly session,
  // CSRF and remote allowlisting. The fixture only inserts its isolated Host
  // routes ahead of the process-wide router; no production auth middleware is
  // bypassed and no client HTML is substituted.
  await setRemotePin(FIXTURE_PIN)
  await setRemoteEnabled(true)
  const app = createRemoteApp()
  const fixtureControl = Router()
  fixtureControl.use('/api', createAgentRouter(host, packages))
  // The normal project router closes over the process-wide AgentHost singleton.
  // This isolated fixture owns a separate Host, so route the one write used by
  // the browser through that Host and acknowledge staged canvas results there.
  fixtureControl.post('/api/project', async (request, response) => {
    const id = typeof request.query.project === 'string' ? request.query.project.trim() : ''
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as { snapshot?: unknown; expectedRevision?: unknown; conflictKey?: unknown }
      : {}
    const expectedRevision = body.expectedRevision
    if (!id || !isCanvasSnapshot(body.snapshot)) return response.status(400).json({ error: 'Invalid board snapshot' })
    if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0) return response.status(400).json({ error: 'Invalid board revision' })
    if ((await missingCanvasMedia(body.snapshot)).length > 0) return response.status(400).json({ error: 'Snapshot references a missing media file' })
    try {
      const result = await saveProjectSnapshot(id, body.snapshot, Number(expectedRevision), typeof body.conflictKey === 'string' ? body.conflictKey : undefined)
      if (result.status === 'not-found') return response.status(404).json({ error: 'Board not found' })
      if (result.status === 'conflict') return response.status(409).json({ error: 'Board revision conflict', revision: result.revision, recoveryProject: result.recoveryProject })
      response.json({ ok: true, revision: result.revision })
      void host.acknowledgeCanvasDelivery(id, body.snapshot).catch((error) => {
        process.stderr.write(`live-ui-fixture delivery ack: ${error instanceof Error ? error.message : String(error)}\n`)
      })
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : 'Could not save the board' })
    }
  })
  // The regular status route is lifecycle-gated; this fixture has no launcher
  // lifecycle and exposes only the safe status fields the UI needs.
  fixtureControl.get('/api/status', (_request, response) => response.json({
    falConfigured: false, accountCloudConfigured: false, mockMode: true,
    serverFingerprint: 'live-ui-fixture', uiOpened: true, uiAlive: true,
    instanceId: 'live-ui-fixture', shuttingDown: false,
    build: { version: 'live-ui-fixture', commit: null, date: null, dirty: true },
  }))
  fixtureControl.get('/__fixture/state', async (_request, response) => {
    const durableProject = await loadProjectSnapshot(project.id)
    response.json({
      project: durableProject ?? project,
      llmCalls: { submits: llmProvider.submits, resumes: llmProvider.resumes, cancels: llmProvider.cancels },
      runnerCalls: calls,
      tasks: (await host.list()).map((task) => host.view(task)),
    })
  })
  // createRemoteApp installs its API and final tablet fallback before this
  // fixture is assembled. Move the fixture router in front of that exact
  // production API layer; the preceding production layer still performs the
  // session, CSRF and allowlist checks for every /api request.
  app.use(fixtureControl)
  const stack = (app as unknown as { _router?: { stack?: Array<{ handle?: unknown }> } })._router?.stack
  if (!stack) throw new Error('Could not find the production Express router')
  const controlLayerIndex = stack.findIndex((layer) => layer.handle === fixtureControl)
  const apiLayerIndex = stack.findIndex((layer) => layer.handle === apiRouter)
  if (controlLayerIndex < 0 || apiLayerIndex < 0) throw new Error('Production remote router is missing the expected fixture/API layers')
  const [controlLayer] = stack.splice(controlLayerIndex, 1)
  if (!controlLayer) throw new Error('Could not reorder the fixture router')
  const targetApiLayerIndex = stack.findIndex((layer) => layer.handle === apiRouter)
  if (targetApiLayerIndex < 0) throw new Error('Production API layer disappeared while building the fixture')
  stack.splice(targetApiLayerIndex, 0, controlLayer)

  const server = http.createServer(app)
  // A second production-style loopback app gives the browser a real Desktop
  // entrypoint while the first server remains the authenticated tablet/LAN
  // door. Both apps share this fixture's injected Host/router and data dir.
  const desktopApp = express()
  desktopApp.disable('x-powered-by')
  desktopApp.use((request, response, next) => {
    const rawHost = String(request.headers.host ?? '').toLowerCase()
    const hostname = rawHost.startsWith('[')
      ? rawHost.slice(1, rawHost.indexOf(']'))
      : rawHost.split(':')[0]
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
      response.status(403).json({ error: 'Invalid Host' })
      return
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    const origin = request.headers.origin
    if (unsafe && origin) {
      try {
        const parsed = new URL(origin)
        if (parsed.protocol !== 'http:'
          || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1')) {
          response.status(403).json({ error: 'Invalid Origin' })
          return
        }
      } catch {
        response.status(403).json({ error: 'Invalid Origin' })
        return
      }
    }
    next()
  })
  desktopApp.use(express.json({ limit: '50mb' }))
  attachMediaRoutes(desktopApp)
  desktopApp.use(fixtureControl)
  desktopApp.use('/api', apiRouter)
  desktopApp.use(express.static(clientDist))
  const desktopServer = http.createServer(desktopApp)
  const shutdown = async () => {
    await host.close()
    await Promise.all([closeServer(server), closeServer(desktopServer)])
    process.exit(0)
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  let desktopPort: number
  try {
    await listenOn(server, env.port)
    desktopPort = await listenFirstFree(desktopServer, Math.max(8793, env.port + 1))
  } catch (error) {
    await Promise.all([closeServer(server), closeServer(desktopServer)])
    await host.close()
    throw error
  }
  process.stdout.write(JSON.stringify({
    type: 'LIVE_FIXTURE_READY',
    url: `http://127.0.0.1:${env.port}/`,
    desktopUrl: `http://127.0.0.1:${desktopPort}/`,
    desktopPort,
    testPin: FIXTURE_PIN,
    projectId: project.id,
    projectRevision: project.revision,
    selectedItemId: 'live-selected-item',
    dataDir: env.dataDir,
    fixturePid: process.pid,
  }) + '\n')
}

main().catch((error) => {
  process.stderr.write(`live-ui-fixture: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
