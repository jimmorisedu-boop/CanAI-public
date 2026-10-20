import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasStore } from './konva/canvasStore.js'
import { bindMacroRunToBoard, dismissUnusedSlots, macroRunSummary, type MacroRunState } from './macroRunClient.js'

function run(): MacroRunState {
  return {
    id: 'run_safe', macroId: 'macro_safe', macroName: 'Макрос', projectId: 'project_safe',
    status: 'running', startedAt: 1, delivered: 0, placeholderIds: ['pending_safe'],
    placeholderByNode: { node_safe: 'pending_safe' },
    nodes: { node_safe: { status: 'queued', jobId: 'local-job~project_safe~job_safe' } },
  }
}

test('локальный макрос привязывает статус и отдаёт job клиентскому delivery registry', () => {
  const assigned: Array<[string, string]> = []
  const store = {
    setPendingJob(slot: string, jobId: string) { assigned.push([slot, jobId]) },
    failPendingById() {},
  } as unknown as CanvasStore

  const fresh = bindMacroRunToBoard(run(), store, new Set(), 'local')

  assert.deepEqual(assigned, [['pending_safe', 'local-job~project_safe~job_safe']])
  assert.deepEqual(fresh, ['local-job~project_safe~job_safe'])
})

test('macro progress and terminal errors use English system presentation while preserving the macro name', () => {
  const active = run()
  active.nodes.node_safe = { status: 'running', progress: 'загрузка' }
  assert.equal(macroRunSummary(active), 'Макрос: Uploading…')
  const failed = { ...active, status: 'error' as const, error: 'Нет связи' }
  assert.equal(macroRunSummary(failed), 'Макрос: Connection lost.')
})

test('local macro по-прежнему отдаёт job клиентскому delivery registry', () => {
  const store = { setPendingJob() {}, failPendingById() {} } as unknown as CanvasStore
  assert.deepEqual(
    bindMacroRunToBoard(run(), store, new Set(), 'local'),
    ['local-job~project_safe~job_safe'],
  )
})

test('локальное восстановление убирает успешный output без jobId', () => {
  const dismissed: string[] = []
  const direct = run()
  direct.status = 'done'
  direct.nodes.node_safe = { status: 'done' }
  const store = {
    getPending: () => [{ id: 'pending_safe' }],
    dismissPendingById: (id: string) => dismissed.push(id),
  } as unknown as CanvasStore

  dismissUnusedSlots(direct, store, 'local')

  assert.deepEqual(dismissed, ['pending_safe'])
})

test('локальное восстановление удаляет только slot без связанной ноды', () => {
  const dismissed: string[] = []
  const extra = run()
  extra.placeholderIds.push('pending_unused')
  const store = {
    getPending: () => [{ id: 'pending_safe' }, { id: 'pending_unused' }],
    dismissPendingById: (id: string) => dismissed.push(id),
  } as unknown as CanvasStore

  dismissUnusedSlots(extra, store, 'local')

  assert.deepEqual(dismissed, ['pending_unused'])
})
