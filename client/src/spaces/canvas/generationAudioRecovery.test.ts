import assert from 'node:assert/strict'
import test from 'node:test'
import type { RestoredGenerationTask } from './generationRegistry'
import { CanvasStore } from './konva/canvasStore'
import { restoreProjectGenerationTasks } from './projectSync'

test('completed audio and other generated results return to Tasks after a board round trip', () => {
  const original = new CanvasStore()
  const launch = {
    launchId: 'audio-launch', projectId: 'board-audio', projectName: 'Audio board',
    variantCount: 1, variantIndex: 1, promptPreview: 'A quiet melody',
    modelId: 'audio-model', modelName: 'Audio model', createdAt: 100,
  }
  original.loadDoc({
    version: 1, camera: { x: 0, y: 0, scale: 1 },
    items: [
      ...(['image', 'video', 'text', 'audio'] as const).map((kind) => ({
        id: `${kind}-result`, kind, x: 0, y: 0, w: 320, h: 180,
        ...(kind === 'text' ? { text: 'Generated text' } : { src: `/media/result-${kind}` }),
        sourceJobId: `job-${kind}`, sourceLaunch: launch,
      })),
      { id: 'imported-audio', kind: 'audio', x: 0, y: 0, w: 320, h: 80, src: '/media/import.mp3' },
      { id: 'local-audio', kind: 'audio', x: 0, y: 0, w: 320, h: 80,
        src: '/media/local.mp3', sourceJobId: 'local:failed-launch' },
    ],
    archive: [{
      id: 'archived-audio', kind: 'audio', x: 0, y: 0, w: 320, h: 80,
      src: '/media/archived.mp3', sourceJobId: 'job-archived-audio',
      sourceLaunch: launch, archivedAt: 200,
    }],
  })
  const snapshot = original.toDoc()
  const reopened = new CanvasStore()
  reopened.loadDoc(JSON.parse(JSON.stringify(snapshot)))
  const restored: RestoredGenerationTask[] = []

  restoreProjectGenerationTasks(reopened, 'board-audio', {
    trackGeneration: () => assert.fail('Completed results must not start polling or another generation'),
    restoreGenerationTask: (task) => { restored.push(task) },
  })

  assert.deepEqual(restored.map(({ jobId, jobKind, state }) => ({ jobId, jobKind, state })), [
    { jobId: 'job-image', jobKind: 'image', state: 'done' },
    { jobId: 'job-video', jobKind: 'video', state: 'done' },
    { jobId: 'job-text', jobKind: 'text', state: 'done' },
    { jobId: 'job-audio', jobKind: 'audio', state: 'done' },
    { jobId: 'job-archived-audio', jobKind: 'audio', state: 'done' },
  ])
  const audio = restored.find((task) => task.jobId === 'job-audio')!
  assert.deepEqual(audio.target, { kind: 'canvas', projectId: 'board-audio' })
  assert.deepEqual(audio.launch, launch)
  assert.equal(audio.createdAt, 100)
  assert.deepEqual(reopened.toDoc(), snapshot, 'Restoring Tasks must preserve board media and metadata')
})
