import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-projects-recovery-'))
const previousDataDir = process.env.CANAI_DATA_DIR
const previousEnvFile = process.env.CANAI_ENV_FILE
process.env.CANAI_DATA_DIR = dataDir
process.env.CANAI_ENV_FILE = path.join(dataDir, '.env')

const { createProject, ensureProjects, listProjects } = await import('./projects.js')
const { gcMedia } = await import('./gc.js')
const { JobStore } = await import('./jobs.js')
const { hasPendingDurableRecovery } = await import('./durableJsonRecovery.js')

test('project index recovery preserves corruption, restores missing primary, and fails closed when both copies are bad', async (t) => {
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.CANAI_DATA_DIR
    else process.env.CANAI_DATA_DIR = previousDataDir
    if (previousEnvFile === undefined) delete process.env.CANAI_ENV_FILE
    else process.env.CANAI_ENV_FILE = previousEnvFile
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  })

  await ensureProjects()
  await createProject('Backup board')
  const indexFile = path.join(dataDir, 'projects.json')
  const backupFile = `${indexFile}.bak`
  const backupBefore = await fs.readFile(backupFile, 'utf8')
  await fs.writeFile(indexFile, '{broken', 'utf8')

  const recovered = await listProjects()
  assert.deepEqual(
    recovered.map((project) => project.name),
    (JSON.parse(backupBefore) as Array<{ name: string }>).map((project) => project.name),
    'the valid backup is the source of truth after primary corruption',
  )
  const quarantined = (await fs.readdir(dataDir)).filter((name) => name.startsWith('projects.json.corrupt-'))
  assert.equal(quarantined.length, 1, 'the corrupt projects index remains available for diagnosis')
  const restoredText = await fs.readFile(indexFile, 'utf8')
  assert.doesNotThrow(() => JSON.parse(restoredText))

  await fs.rm(indexFile)
  await ensureProjects()
  assert.ok((await listProjects()).length > 0, 'a valid backup must prevent first-run initialization from replacing the index')
  const marker = path.join(dataDir, 'projects.json.recovery-pending')
  await fs.access(marker)
  assert.equal(await hasPendingDurableRecovery(dataDir), true)
  const mediaDir = path.join(dataDir, 'media')
  await fs.mkdir(mediaDir, { recursive: true })
  const orphan = path.join(mediaDir, 'orphan-after-recovery.png')
  await fs.writeFile(orphan, 'keep until reviewed', 'utf8')
  const gcResult = await gcMedia(0)
  assert.equal(gcResult.removed, 0, 'GC must stay paused while recovered board metadata awaits review')
  await fs.access(orphan)

  // Review the board marker, then verify an independent jobs recovery keeps
  // paid-result media protected on later restarts as well.
  await fs.rm(marker)
  const jobsFile = path.join(dataDir, 'jobs.json')
  const initialJobs = new JobStore(jobsFile)
  const uncertain = initialJobs.create('image', 'keep this result', [{ kind: 'image', src: '/media/job-result.png' }])
  uncertain.generationRoute = 'local'
  uncertain.status = 'running'
  await initialJobs.persistNow()
  await initialJobs.persistNow()
  await fs.writeFile(jobsFile, '{broken', 'utf8')
  const recoveredJobs = new JobStore(jobsFile)
  assert.deepEqual(await recoveredJobs.restore(), [], 'a backup without a provider binding must not be queued again')
  const jobsMarker = path.join(dataDir, 'jobs.json.recovery-pending')
  await fs.access(jobsMarker)
  assert.equal(await hasPendingDurableRecovery(dataDir), true)
  const jobOrphan = path.join(mediaDir, 'orphan-after-job-recovery.png')
  await fs.writeFile(jobOrphan, 'keep this paid-result candidate', 'utf8')
  assert.equal((await gcMedia(0)).removed, 0, 'GC must remain paused while recovered job evidence awaits review')
  await fs.access(jobOrphan)

  await fs.writeFile(indexFile, '{primary-broken', 'utf8')
  await fs.writeFile(backupFile, '{backup-broken', 'utf8')
  await assert.rejects(listProjects(), /projects\.json cannot be recovered/u)
  assert.equal(await fs.readFile(indexFile, 'utf8'), '{primary-broken')
  assert.equal(await fs.readFile(backupFile, 'utf8'), '{backup-broken')
})
