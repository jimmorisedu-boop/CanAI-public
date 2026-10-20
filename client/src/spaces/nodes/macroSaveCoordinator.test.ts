// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import {
  MacroLoadGuard,
  createMacroSaveCoordinator,
  deleteConfirmedMacroAfterSave,
  saveMacroBeforeLeave,
  type MacroSaveState,
} from './macroSaveCoordinator.js'
import * as macroSaveModule from './macroSaveCoordinator.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('dirty macro is persisted before leaving the editor', async () => {
  const events: string[] = []

  await saveMacroBeforeLeave({
    state: 'dirty',
    persist: async () => {
      events.push('saved')
    },
    currentSave: null,
  })

  assert.deepEqual(events, ['saved'])
})

test('an in-flight macro save finishes before leaving the editor', async () => {
  const saving = deferred()
  let finished = false
  const leaving = saveMacroBeforeLeave({
    state: 'saving',
    persist: async () => {
      throw new Error('a second save must not start')
    },
    currentSave: saving.promise.then(() => {
      finished = true
    }),
  })

  assert.equal(finished, false)
  saving.resolve()
  await leaving
  assert.equal(finished, true)
})

test('change during save stays saving and finalize waits for the follow-up save', async () => {
  let document = 'A'
  let savedFingerprint = 'старое'
  const states: MacroSaveState[] = []
  const saves: string[] = []
  const first = deferred()
  const second = deferred()
  const pending = [first, second]
  const coordinator = createMacroSaveCoordinator({
    getSnapshot: () => ({ fingerprint: document, value: document }),
    getSavedFingerprint: () => savedFingerprint,
    setSavedFingerprint: (fingerprint) => {
      savedFingerprint = fingerprint
    },
    save: async (snapshot) => {
      saves.push(snapshot.value)
      await pending.shift()!.promise
    },
    onState: (state) => states.push(state),
  })

  const finalize = coordinator.requestSave()
  document = 'B'
  const duringSave = coordinator.requestSave()
  assert.strictEqual(duringSave, finalize)

  first.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(saves, ['A', 'B'])
  assert.equal(states.at(-1), 'saving')

  second.resolve()
  await finalize
  assert.equal(savedFingerprint, 'B')
  assert.equal(states.at(-1), 'saved')
})

test('confirmed reload clears conflict and rejects an older load response', () => {
  const guard = new MacroLoadGuard()
  const first = guard.begin()
  let saveError: string | null = 'конфликт'

  guard.invalidate(() => {
    saveError = null
  })
  const second = guard.begin()

  assert.equal(saveError, null)
  assert.equal(guard.isCurrent(first), false)
  assert.equal(guard.isCurrent(second), true)
})

test('load failure enables retry and only the retried load may finish', () => {
  const guard = new MacroLoadGuard()
  const failedLoad = guard.begin()

  assert.equal(guard.isLoading(), true)
  assert.equal(guard.complete(failedLoad), true)
  assert.equal(guard.isLoading(), false)
  assert.equal(guard.canRetry(true), true)

  const retriedLoad = guard.begin()
  assert.equal(guard.isLoading(), true)
  assert.equal(guard.complete(failedLoad), false)
  assert.equal(guard.complete(retriedLoad), true)
  assert.equal(guard.isLoading(), false)
})

test('clear waits for an in-flight create and deletes its confirmed revision', async () => {
  const creating = deferred()
  let confirmed: { id: string; revision: number } | null = null
  const deletes: Array<{ id: string; revision: number }> = []
  const currentSave = creating.promise.then(() => {
    confirmed = { id: 'created-during-save', revision: 1 }
  })

  const clearing = deleteConfirmedMacroAfterSave({
    currentSave,
    expectedMacroId: null,
    getConfirmedMacro: () => confirmed,
    deleteMacro: async (id, revision) => {
      deletes.push({ id, revision })
    },
  })

  await Promise.resolve()
  assert.deepEqual(deletes, [])
  creating.resolve()
  await clearing
  assert.deepEqual(deletes, [{ id: 'created-during-save', revision: 1 }])
})

test('existing macro without a confirmed revision cannot be cleared locally', async () => {
  let deleted = false

  await assert.rejects(
    deleteConfirmedMacroAfterSave({
      currentSave: null,
      expectedMacroId: 'existing-macro',
      getConfirmedMacro: () => null,
      deleteMacro: async () => {
        deleted = true
      },
    }),
    /revision|loaded/i,
  )

  assert.equal(deleted, false)
})

test('load_failed разрешает только revision-aware recovery delete после подтверждения ревизии', async () => {
  const canClearMacroSlot = (
    macroSaveModule as unknown as {
      canClearMacroSlot?: (state: {
        macroId: string | null
        revision: number | null
        loaded: boolean
        isLoading: boolean
        loadError: string | null
      }) => boolean
    }
  ).canClearMacroSlot

  assert.equal(typeof canClearMacroSlot, 'function')
  assert.equal(
    canClearMacroSlot!({
      macroId: 'existing',
      revision: null,
      loaded: false,
      isLoading: true,
      loadError: null,
    }),
    false,
  )
  assert.equal(
    canClearMacroSlot!({
      macroId: 'existing',
      revision: null,
      loaded: false,
      isLoading: false,
      loadError: 'сеть недоступна',
    }),
    false,
  )
  const recoveryState = {
    macroId: 'corrupted-macro',
    revision: 7,
    loaded: false,
    isLoading: false,
    loadError: 'Граф макроса повреждён',
  }
  assert.equal(
    canClearMacroSlot!(recoveryState),
    true,
  )
  assert.equal(
    canClearMacroSlot!({
      ...recoveryState,
      isLoading: true,
    }),
    false,
  )
  assert.equal(
    canClearMacroSlot!({
      macroId: 'healthy-macro',
      revision: 4,
      loaded: true,
      isLoading: false,
      loadError: null,
    }),
    true,
  )

  const deletes: Array<{ id: string; revision: number }> = []
  await deleteConfirmedMacroAfterSave({
    currentSave: null,
    expectedMacroId: recoveryState.macroId,
    getConfirmedMacro: () => ({
      id: recoveryState.macroId,
      revision: recoveryState.revision,
    }),
    deleteMacro: async (id, revision) => {
      deletes.push({ id, revision })
    },
  })
  assert.deepEqual(deletes, [{ id: 'corrupted-macro', revision: 7 }])
})
