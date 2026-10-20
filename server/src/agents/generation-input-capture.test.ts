import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('native capture freezes board media, is idempotent, and rejects a changed source at start admission', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-agent-capture-'))
  process.env.CANAI_DATA_DIR = dataDir
  process.env.CANAI_ENV_FILE = path.join(dataDir, 'none.env')
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))

  const { config } = await import('../config.js')
  const { createProject, ensureProjects } = await import('../projects.js')
  const { captureGenerationInputs, validateCapturedArtifacts } = await import('./generation-input-capture.js')
  await ensureProjects()
  await fs.mkdir(config.mediaDir, { recursive: true })
  const source = Buffer.from('native-image-v1')
  await fs.writeFile(path.join(config.mediaDir, 'native.png'), source)
  const project = await createProject('Capture fixture', {
    version: 1,
    items: [{ id: 'item-a', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: '/media/native.png', name: 'Native', mime: 'image/png' }],
    camera: { x: 0, y: 0, scale: 1 },
  })
  const request = { projectRef: { source: 'local' as const, id: project.id }, projectRevision: 1, inputs: [{ itemId: 'item-a', kind: 'image' as const }] }
  const first = await captureGenerationInputs(request, config.mediaDir)
  assert.equal(first.length, 1)
  assert.equal(first[0]?.artifact.checksum, crypto.createHash('sha256').update(source).digest('hex'))
  assert.equal(first[0]?.artifact.provenance, 'reference')
  assert.match(first[0]!.artifact.mediaSrc, /^\/media\/agent-ref-[a-f0-9]+\.png$/u)

  const replay = await captureGenerationInputs(request, config.mediaDir)
  assert.deepEqual(replay, first)

  const grantRefs = [{ artifactId: first[0]!.artifact.artifactId, revision: first[0]!.artifact.revision, checksum: first[0]!.artifact.checksum }]
  assert.deepEqual(await validateCapturedArtifacts(first, config.mediaDir, grantRefs, project.id), [first[0]!.artifact])

  await assert.rejects(
    captureGenerationInputs({ ...request, projectRevision: 2 }, config.mediaDir),
    (error: unknown) => error instanceof Error && error.message.includes('Board changed'),
  )

  await fs.writeFile(path.join(config.mediaDir, 'native.png'), Buffer.from('native-image-v2'))
  const changed = await captureGenerationInputs(request, config.mediaDir)
  assert.notEqual(changed[0]?.artifact.checksum, first[0]?.artifact.checksum)
  await assert.rejects(
    validateCapturedArtifacts(first, config.mediaDir, grantRefs, project.id),
    (error: unknown) => error instanceof Error && error.message.includes('changed'),
  )
})
