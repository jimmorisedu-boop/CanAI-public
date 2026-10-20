// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import { api } from '../../../api'
import type { SessionDraft } from '../../../types'
import {
  flushSessionDraft,
  resetSessionDraftMemory,
  scheduleSessionDraftSave,
} from './sessionDraftSync'

test('смена доски не теряет черновик, который cleanup уже поставил на flush', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalSave = api.saveSessionDraft
  const calls: Array<{ projectId: string; draft: SessionDraft }> = []
  const draft: SessionDraft = { prompt: 'старый промпт', kind: 'image' }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  })
  api.saveSessionDraft = async (projectId, savedDraft) => {
    calls.push({ projectId, draft: savedDraft })
    return { ok: true, draft: savedDraft }
  }

  try {
    resetSessionDraftMemory()
    scheduleSessionDraftSave('old-board', draft, 'local')
    // Точная последовательность двух React effects при смене projectId:
    // cleanup очередит flush, следующий effect сразу очищает память новой доски.
    const flushing = flushSessionDraft()
    resetSessionDraftMemory()
    await flushing
    assert.deepEqual(calls, [{ projectId: 'old-board', draft }])
  } finally {
    api.saveSessionDraft = originalSave
    resetSessionDraftMemory()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
