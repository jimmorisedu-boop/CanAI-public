import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import type { MacroGraph } from './macroGraph.js'
import type { MacroRunState } from './macroRuns.js'

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Macro did not finish in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const graph: MacroGraph = {
  nodes: [
    { id: 'note', data: { kind: 'note', prompt: 'Ready text' } },
    { id: 'out', data: { kind: 'output' } },
  ],
  edges: [{ id: 'edge', source: 'note', target: 'out', sourceHandle: 'text' }],
}

test('local macro outputs are durable and delivered through jobs', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-verify-macro-delivery-'))
  process.env.CANAI_DATA_DIR = dataDir
  process.env.CANAI_ENV_FILE = path.join(dataDir, 'missing.env')
  process.env.CANAI_MOCK = '1'
  const [macros, { deliveringNodeIds }, { jobs, MAX_LIVE_JOBS }, { generationGate }, runner, projects, presence, { apiRouter }] = await Promise.all([
    import('./macroRuns.js'), import('./macroGraph.js'), import('./jobs.js'),
    import('./generationGate.js'), import('./runner.js'), import('./projects.js'),
    import('./boardPresence.js'), import('./routes.js'),
  ])
  await generationGate.closeAndWait()
  const app = express()
  app.use('/api', apiRouter)
  const http = app.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const runsFile = path.join(dataDir, 'macro-runs.json')

  async function finished(run: MacroRunState): Promise<void> {
    await waitFor(() => run.status !== 'running')
    assert.equal(run.status, 'done', run.error)
    await waitFor(async () => {
      try {
        const disk = JSON.parse(await fs.readFile(runsFile, 'utf8')) as { runs: MacroRunState[] }
        return disk.runs.some((entry) => entry.id === run.id && entry.status === 'done')
      } catch { return false }
    })
  }

  async function items(projectId: string): Promise<Record<string, unknown>[]> {
    const saved = (await projects.loadProjectSnapshot(projectId))?.snapshot as { items?: Record<string, unknown>[] } | null
    return saved?.items ?? []
  }

  t.after(async () => {
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
    presence.resetBoardPresence()
    macros.resetMacroRuns()
    for (const job of jobs.all()) jobs.remove(job.id)
    await jobs.persistNow()
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  await t.test('note to output puts text on a closed local board', async () => {
    const board = await projects.createProject('Text')
    const run = macros.startMacroRun({ macroId: 'note', macroName: 'Text', projectId: board.id, graph, seedRefs: [], placeholderIds: [] })
    await finished(run)
    assert.equal(run.delivered, 1)
    const placed = await items(board.id)
    assert.equal(placed.length, 1)
    assert.equal(placed[0].kind, 'text')
    assert.equal(placed[0].text, 'Ready text')
    const job = jobs.get(run.nodes.note.jobId!)!
    assert.ok(job)
    assert.equal(placed[0].sourceJobId, job.id)
    assert.equal(job.status, 'done')
    assert.equal(job.falRequestId, undefined)
    job.deliveredAt = undefined
    await runner.deliverJobResult(job)
    assert.equal((await items(board.id)).length, 1)
    const saved = await projects.loadProjectSnapshot(board.id)
    await projects.saveProjectSnapshot(board.id, { ...(saved!.snapshot as object), items: [], archive: placed }, saved!.revision)
    job.deliveredAt = undefined
    await runner.deliverJobResult(job)
    assert.equal((await items(board.id)).length, 0)
  })

  await t.test('delivery planning reserves text and media slots', () => {
    assert.deepEqual(deliveringNodeIds({
      nodes: [...graph.nodes, { id: 'media', data: { kind: 'media', result: { url: '/media/ready.png' } } }],
      edges: [...graph.edges, { id: 'media-out', source: 'media', target: 'out' }],
    }), ['note', 'media'])
  })

  await t.test('an open local board defers delivery and survives restart without a duplicate job', async () => {
    const board = await projects.createProject('Open board')
    presence.claimBoard(board.id, 'device-1', 'Open board')
    await projects.saveProjectSnapshot(board.id, { version: 1, items: [], pending: [{ id: 'open-slot', x: 10, y: 20, w: 300, h: 200 }] }, 0)
    const run = macros.startMacroRun({ macroId: 'note', macroName: 'Text', projectId: board.id, graph, seedRefs: [], placeholderIds: ['open-slot'] })
    await finished(run)
    assert.equal(run.placeholderByNode.note, 'open-slot')
    const jobId = run.nodes.note.jobId
    assert.ok(jobId)
    assert.equal(jobs.get(jobId)?.deliveredAt, undefined)
    assert.deepEqual(await items(board.id), [])
    const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')) as { jobs: Array<{ id: string; result?: unknown }> }
    assert.deepEqual(disk.jobs.find((entry) => entry.id === jobId)?.result, { text: 'Ready text' })
    const jobCount = jobs.all().length
    const interrupted = { ...run, status: 'running' as const, graph, deliveredNodeIds: [], finishedAt: undefined }
    await fs.writeFile(runsFile, JSON.stringify({ version: 1, runs: [interrupted] }))
    macros.resetMacroRuns()
    for (const job of jobs.all()) jobs.remove(job.id)
    await runner.restoreJobs()
    await macros.restoreMacroRuns()
    const restored = macros.getMacroRun(run.id)!
    await finished(restored)
    assert.equal(restored.nodes.note.jobId, jobId)
    assert.equal(jobs.all().length, jobCount)
    assert.deepEqual(await items(board.id), [])
    presence.resetBoardPresence()
    await runner.deliverJobResult(jobs.get(jobId)!)
    assert.equal((await items(board.id)).length, 1)
    jobs.get(jobId)!.deliveredAt = undefined
    await runner.deliverJobResult(jobs.get(jobId)!)
    assert.equal((await items(board.id)).length, 1)
  })

  await t.test('a missing saved task fails without a new paid submit', async () => {
    const board = await projects.createProject('Missing saved task')
    const missingJobId = 'job-from-before-restart'
    const run: MacroRunState = {
      id: 'macro-with-missing-job', macroId: 'missing-job', macroName: 'Missing saved task', projectId: board.id,
      status: 'running', startedAt: Date.now(), delivered: 0, placeholderIds: [], placeholderByNode: {},
      nodes: { image: { status: 'running', jobId: missingJobId } }, deliveredNodeIds: [],
      graph: { nodes: [{ id: 'image', data: { kind: 'image', prompt: 'a portrait' } }], edges: [] },
      seedRefs: [], resumable: true,
    }
    const before = jobs.all().map((job) => job.id)
    await fs.writeFile(runsFile, JSON.stringify({ version: 1, runs: [run] }))
    macros.resetMacroRuns()
    await macros.restoreMacroRuns()
    const restored = macros.getMacroRun(run.id)!
    await waitFor(() => restored.status !== 'running')
    assert.equal(restored.status, 'error')
    assert.match(restored.error ?? '', /saved generation task is missing/i)
    assert.match(restored.error ?? '', /manual|review|duplicate charge/i)
    assert.equal(restored.nodes.image.status, 'error')
    assert.deepEqual(jobs.all().map((job) => job.id), before)
  })

  await t.test('ready media is delivered with the same URL without generation', async () => {
    const board = await projects.createProject('Media')
    const mediaGraph: MacroGraph = {
      nodes: [
        { id: 'media', data: { kind: 'media', result: { url: '/media/ready.png', mime: 'image/png', width: 100, height: 50 } } },
        { id: 'out', data: { kind: 'output' } },
      ],
      edges: [{ id: 'edge', source: 'media', target: 'out', sourceHandle: 'image' }],
    }
    const run = macros.startMacroRun({ macroId: 'media', macroName: 'Media', projectId: board.id, graph: mediaGraph, seedRefs: [], placeholderIds: [] })
    await finished(run)
    const placed = await items(board.id)
    assert.equal(placed.length, 1)
    assert.equal(placed[0].src, '/media/ready.png')
    assert.equal(placed[0].kind, 'image')
    assert.equal(jobs.get(run.nodes.media.jobId!)?.falRequestId, undefined)
  })

  await t.test('HTTP API returns a ready output while hiding internal compaction jobs', async () => {
    const busyJobs = Array.from({ length: MAX_LIVE_JOBS }, () => jobs.create('text', 'Accepted task', []))
    const board = await projects.createProject('HTTP delivery')
    presence.claimBoard(board.id, 'device-http', 'HTTP client')
    const run = macros.startMacroRun({ macroId: 'note-http', macroName: 'Text', projectId: board.id, graph, seedRefs: [], placeholderIds: ['http-slot'] })
    await finished(run)
    assert.equal(jobs.liveCount(), MAX_LIVE_JOBS)
    const response = await fetch(`${baseUrl}/api/jobs/${run.nodes.note.jobId}`)
    assert.equal(response.status, 200)
    const body = await response.json() as { status: string; result: unknown; internal?: unknown; target?: { kind?: string; projectId?: string; placeholderId?: string } }
    assert.equal(body.status, 'done')
    assert.deepEqual(body.result, { text: 'Ready text' })
    assert.equal(body.internal, undefined)
    assert.deepEqual(body.target, { kind: 'canvas', projectId: board.id, placeholderId: 'http-slot' })
    const internal = jobs.create('text', 'Memory', [], 'qwen', {}, { kind: 'prompt-chat-compaction', projectId: board.id, conversationId: 'chat-1', fromMessageId: null, throughMessageId: 'message-1', contextRevision: 0 }, true)
    assert.equal((await fetch(`${baseUrl}/api/jobs/${internal.id}`)).status, 404)
    jobs.remove(internal.id)
    for (const job of busyJobs) jobs.remove(job.id)
    presence.resetBoardPresence()
  })

  await t.test('final macro-runs write retries transient rename locks', async (st) => {
    let run: MacroRunState | undefined
    let transientFailures = 0
    let renameAttempts = 0
    let finalSnapshotWrites = 0
    let tempContainsFinalSnapshot = false
    const realWriteFile = fs.writeFile
    const realRename = fs.rename
    st.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      const [file, contents] = args
      const isRunsTemp = typeof file === 'string' && file === `${runsFile}.${process.pid}.tmp`
      let isFinalSnapshot = false
      if (isRunsTemp && run) {
        try {
          const parsed = JSON.parse(String(contents)) as { runs?: Array<{ id?: string; status?: string }> }
          isFinalSnapshot = parsed.runs?.some((entry) => entry.id === run?.id && entry.status === 'done') === true
        } catch { /* production writer reports malformed data */ }
      }
      if (isFinalSnapshot) {
        finalSnapshotWrites += 1
        if (finalSnapshotWrites > 1) throw new Error('follow-up final write blocked by the test lock')
      }
      if (isRunsTemp) tempContainsFinalSnapshot = isFinalSnapshot
      return realWriteFile(...args)
    })
    const renameMock = st.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      const [source, destination] = args
      const isRunsRename = typeof source === 'string' && typeof destination === 'string'
        && destination === runsFile && source.startsWith(`${runsFile}.`) && source.endsWith('.tmp')
      if (isRunsRename && tempContainsFinalSnapshot && transientFailures < 2) {
        transientFailures += 1
        renameAttempts += 1
        const error = new Error(transientFailures === 1 ? 'rename temporarily denied' : 'rename temporarily busy') as NodeJS.ErrnoException
        error.code = transientFailures === 1 ? 'EPERM' : 'EBUSY'
        throw error
      }
      if (isRunsRename) renameAttempts += 1
      return realRename(...args)
    })
    const board = await projects.createProject('Transient lock')
    run = macros.startMacroRun({ macroId: 'transient-lock', macroName: 'Transient lock', projectId: board.id, graph, seedRefs: [], placeholderIds: [] })
    await waitFor(() => run?.status !== 'running')
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    const disk = JSON.parse(await fs.readFile(runsFile, 'utf8')) as { runs?: Array<{ id?: string; status?: string }> }
    assert.ok(disk.runs?.some((entry) => entry.id === run?.id && entry.status === 'done'))
    renameMock.mock.restore()
    assert.equal(transientFailures, 2)
    assert.equal(finalSnapshotWrites, 1)
    assert.ok(renameAttempts >= 3)
  })

  await t.test('permanent macro-runs write failure remains visible', async (st) => {
    let run: MacroRunState | undefined
    let renameAttempts = 0
    const errors: string[] = []
    const realRename = fs.rename
    st.mock.method(console, 'error', (...args: Parameters<typeof console.error>) => { errors.push(args.map(String).join(' ')) })
    st.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      const [source, destination] = args
      const isRunsRename = typeof source === 'string' && typeof destination === 'string'
        && destination === runsFile && source.startsWith(`${runsFile}.`) && source.endsWith('.tmp')
      if (isRunsRename && run?.status === 'done') {
        renameAttempts += 1
        const error = new Error('permanent disk failure') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      return realRename(...args)
    })
    const board = await projects.createProject('Permanent failure')
    run = macros.startMacroRun({ macroId: 'permanent-failure', macroName: 'Permanent failure', projectId: board.id, graph, seedRefs: [], placeholderIds: [] })
    await waitFor(() => run?.status !== 'running')
    await waitFor(() => errors.some((message) => message.includes('[CanAI:macro-runs]')))
    assert.ok(renameAttempts >= 1)
    assert.ok(errors.some((message) => message.includes('permanent disk failure')))
  })
})
