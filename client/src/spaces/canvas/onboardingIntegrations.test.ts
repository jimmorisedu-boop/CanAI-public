import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import type { Job } from '../../types.js'
import { archiveSelection } from './konva/archiveSelection.js'
import { CanvasStore } from './konva/canvasStore.js'
import { toGenRefs } from './konva/selection.js'
import type { CanvasItem } from './konva/types.js'
import { downloadItemsAsZip, downloadMarkedAsZip } from './konva/zipExport.js'
import {
  buildPendingGenerationMetadata,
  handleSettledCanvasGeneration,
  hasUsedGenerationReferences,
  settleCanvasGeneration,
} from './PromptBar.js'
import { planGeneration } from './promptLaunchPlan.js'
import { loadVersionsForModal, restoreProjectVersionWithOnboarding } from '../../projects/VersionsModal.js'
import { subscribeOnboardingSuccess } from './onboardingEvents.js'

function collectSuccesses(): { events: string[]; stop: () => void } {
  const events: string[] = []
  return { events, stop: subscribeOnboardingSuccess((id) => events.push(id)) }
}

function image(id: string): CanvasItem {
  return { id, kind: 'image', x: 0, y: 0, w: 100, h: 100, src: `/media/${id}.png` }
}

const COMPLETE_JOB: Job = {
  id: 'job-ready',
  kind: 'image',
  prompt: 'Сделай обложку',
  status: 'done',
  result: { url: '/media/result.png', mime: 'image/png', width: 100, height: 100 },
}

test('генерация ждёт размещения и отмечает только реально отправленный референс', async () => {
  const { events, stop } = collectSuccesses()
  const sequence: string[] = []
  let releasePlacement: (() => void) | undefined
  try {
    const metadata = buildPendingGenerationMetadata(
      [{ shapeId: 'image-1', kind: 'image', label: 'референс', src: '/media/reference.png' }],
      [{ kind: 'image', src: '/media/reference.png' }],
    )
    const settling = settleCanvasGeneration(COMPLETE_JOB, {
      getPending: () => [{
        id: 'pending-1',
        jobId: COMPLETE_JOB.id,
        ...metadata,
      }],
      resolveJob: async () => new Promise<void>((resolve) => {
        releasePlacement = () => {
          sequence.push('placed')
          resolve()
        }
      }),
    })

    await Promise.resolve()
    assert.deepEqual(events, [])
    releasePlacement?.()
    await settling
    assert.deepEqual(sequence, ['placed'])
    assert.deepEqual(events, ['first-generation', 'reference-generation'])
  } finally {
    stop()
  }
})

test('не отмечает отмену, пустой результат, неиспользованные референсы и неуспешные действия', async () => {
  const { events, stop } = collectSuccesses()
  const originalFetch = globalThis.fetch
  const originalGenerateAsync = JSZip.prototype.generateAsync
  try {
    await settleCanvasGeneration({ ...COMPLETE_JOB, status: 'error', result: undefined }, {
      getPending: () => [],
      resolveJob: async () => {},
    })
    await settleCanvasGeneration({ ...COMPLETE_JOB, status: 'error', error: 'отменено', result: undefined }, {
      getPending: () => [],
      resolveJob: async () => {},
    })
    await settleCanvasGeneration({ ...COMPLETE_JOB, result: {} }, {
      getPending: () => [],
      resolveJob: async () => {},
    })
    const textAsPromptPlan = planGeneration({
      kind: 'image',
      params: {},
      count: 1,
      refs: [{ shapeId: 'selected-text-is-the-prompt', kind: 'text', label: 'идея', text: 'идея' }],
      sketchTarget: null,
      typedPrompt: '',
      itemById: () => undefined,
      resolveModel: () => null,
    })
    const noReferences = await toGenRefs(textAsPromptPlan.refsToSend, 'image')
    assert.equal(hasUsedGenerationReferences(noReferences), false)
    const textPromptMetadata = buildPendingGenerationMetadata([
      { shapeId: 'selected-text-is-the-prompt', kind: 'text', label: 'идея', text: 'идея' },
    ], noReferences)
    assert.deepEqual(textPromptMetadata, {
      referenceIds: ['selected-text-is-the-prompt'],
      usedReferences: false,
    })
    await settleCanvasGeneration(COMPLETE_JOB, {
      getPending: () => [{
        id: 'pending-text-prompt',
        jobId: COMPLETE_JOB.id,
        ...textPromptMetadata,
      }],
      resolveJob: async () => {},
    })
    assert.deepEqual(events, ['first-generation'])
    events.length = 0
    await settleCanvasGeneration(COMPLETE_JOB, {
      getPending: () => [{
        id: 'modern-no-ref',
        jobId: COMPLETE_JOB.id,
        usedReferences: false,
        retry: { kind: 'image', prompt: 'новый запрос', refs: [{ kind: 'image', src: '/media/legacy.png' }] },
      }],
      resolveJob: async () => {},
    })
    assert.deepEqual(events, ['first-generation'])
    events.length = 0
    await settleCanvasGeneration(COMPLETE_JOB, {
      getPending: () => [{
        id: 'legacy-ref',
        jobId: COMPLETE_JOB.id,
        retry: { kind: 'image', prompt: 'старый запрос', refs: [{ kind: 'image', src: '/media/legacy.png' }] },
      }],
      resolveJob: async () => {},
    })
    assert.deepEqual(events, ['first-generation', 'reference-generation'])
    events.length = 0
    await settleCanvasGeneration(COMPLETE_JOB, {
      getPending: () => [{
        id: 'legacy-empty',
        jobId: COMPLETE_JOB.id,
        retry: { kind: 'image', prompt: 'старый запрос', refs: [] },
      }],
      resolveJob: async () => {},
    })
    assert.deepEqual(events, ['first-generation'])
    events.length = 0
    await settleCanvasGeneration(COMPLETE_JOB, {
      getPending: () => [{ id: 'pending-1' }],
      resolveJob: async () => { throw new Error('не удалось разместить') },
    })

    assert.equal(new CanvasStore().undo(), false)
    await assert.rejects(() => restoreProjectVersionWithOnboarding(
      async () => { throw new Error('сервер недоступен') },
      () => {},
    ))
    assert.equal(archiveSelection(new CanvasStore(), []), 0)
    assert.deepEqual(await downloadItemsAsZip([]), { ok: 0, failed: 0 })
    globalThis.fetch = async () => ({ ok: false, blob: async () => new Uint8Array() } as Response)
    assert.deepEqual(await downloadItemsAsZip([image('unavailable')]), { ok: 0, failed: 1 })
    globalThis.fetch = async () => ({ ok: true, blob: async () => new Uint8Array([1]) } as Response)
    JSZip.prototype.generateAsync = async () => { throw new Error('zip unavailable') }
    await assert.rejects(() => downloadItemsAsZip([image('zip-failure')]))
    assert.deepEqual(events, [])
  } finally {
    globalThis.fetch = originalFetch
    JSZip.prototype.generateAsync = originalGenerateAsync
    stop()
  }
})

test('settled handler не отмечает cancelled, error и пустой done до размещения', async () => {
  const { events, stop } = collectSuccesses()
  const failedJobs: string[] = []
  const localErrors: string[] = []
  const store = {
    failPendingByJob: (jobId: string) => { failedJobs.push(jobId); return false },
    getPending: () => [],
    resolveJob: async () => {},
  }
  try {
    handleSettledCanvasGeneration({ ...COMPLETE_JOB, status: 'error', error: 'отменено', result: undefined }, store, (message) => localErrors.push(message))
    handleSettledCanvasGeneration({ ...COMPLETE_JOB, status: 'error', error: 'сеть', result: undefined }, store, (message) => localErrors.push(message))
    handleSettledCanvasGeneration({ ...COMPLETE_JOB, result: {} }, store, (message) => localErrors.push(message))

    await Promise.resolve()
    assert.deepEqual(failedJobs, [COMPLETE_JOB.id, COMPLETE_JOB.id])
    assert.deepEqual(localErrors, ['Failed: сеть'])
    assert.deepEqual(events, [])
  } finally {
    stop()
  }
})

test('успешные отмена, восстановление, архив, закрепление и экспорт отмечают точные шаги', async () => {
  const { events, stop } = collectSuccesses()
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  let downloadClicks = 0
  try {
    const store = new CanvasStore()
    store.addItem(image('undo'))
    assert.equal(store.undo(), true)

    await restoreProjectVersionWithOnboarding(async () => 'restored', (restored) => {
      assert.equal(restored, 'restored')
      assert.deepEqual(events, ['recovery', 'recovery'])
    })

    const archivedId = store.addItem(image('archive'))
    assert.equal(archiveSelection(store, [archivedId]), 1)
    let assetPublished = false
    const unsubscribe = store.subscribeContent(() => {
      assetPublished ||= store.getAssets().some((asset) => asset.slot === 0)
    })
    const unsubscribeEventOrder = subscribeOnboardingSuccess((id) => {
      if (id === 'save-for-later') assert.equal(assetPublished, true)
    })
    store.pinAsset({ slot: 0, kind: 'image', src: '/media/pin.png' })
    unsubscribeEventOrder()
    unsubscribe()
    assert.equal(assetPublished, true)

    globalThis.fetch = async () => ({ ok: true, blob: async () => new Uint8Array([1, 2, 3]) } as Response)
    ;(globalThis as Record<string, unknown>).document = {
      createElement: () => ({
        href: '',
        download: '',
        click: () => {
          downloadClicks++
          assert.equal(events.length, 3 + downloadClicks)
        },
        remove() {},
      }),
      body: { appendChild() {} },
    }
    URL.createObjectURL = () => 'blob:test'
    URL.revokeObjectURL = () => {}

    assert.deepEqual(await downloadItemsAsZip([image('export')]), { ok: 1, failed: 0 })
    assert.equal(downloadClicks, 1)
    assert.deepEqual(events, ['recovery', 'recovery', 'save-for-later', 'save-for-later', 'export'])

    assert.deepEqual(
      await downloadMarkedAsZip(
        [{ ...image('marked'), mark: 1 }],
        'доска-1',
        async () => ({ board: 'доска', starts: { '1': 1 } }),
      ),
      { ok: 1, failed: 0, groups: 1 },
    )
    assert.deepEqual(events, ['recovery', 'recovery', 'save-for-later', 'save-for-later', 'export', 'export'])
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as Record<string, unknown>).document = originalDocument
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    stop()
  }
})

test('прямой и обычный архив сообщают об успехе ровно по одному разу', () => {
  const { events, stop } = collectSuccesses()
  try {
    const directStore = new CanvasStore()
    const directId = directStore.addItem(image('compare-archive'))
    assert.equal(directStore.archiveItems([directId]), 1)
    assert.deepEqual(events, ['save-for-later'])

    events.length = 0
    const ordinaryStore = new CanvasStore()
    const ordinaryId = ordinaryStore.addItem(image('ordinary-archive'))
    assert.equal(archiveSelection(ordinaryStore, [ordinaryId]), 1)
    assert.deepEqual(events, ['save-for-later'])
  } finally {
    stop()
  }
})

test('импорт, redo и production-загрузка VersionsModal не считаются успехом обучения', async () => {
  const { events, stop } = collectSuccesses()
  try {
    const store = new CanvasStore()
    store.addImportedAt({
      kind: 'image', src: '/media/import.png', mime: 'image/png', name: 'импорт', naturalW: 100, naturalH: 100,
    }, { x: 50, y: 50 })
    assert.deepEqual(events, [])
    store.undo()
    events.length = 0
    store.redo()

    const requested: string[] = []
    assert.deepEqual(await loadVersionsForModal('project-1', async (projectId) => {
      requested.push(projectId)
      return { versions: [] }
    }), [])
    assert.deepEqual(requested, ['project-1'])
    assert.deepEqual(events, [])
  } finally {
    stop()
  }
})
