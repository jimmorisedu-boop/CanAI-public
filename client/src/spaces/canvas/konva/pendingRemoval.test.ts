import assert from 'node:assert/strict'
import test from 'node:test'
import { ORPHAN_LAUNCH_AFTER_MS } from '../pendingLaunchState.js'
import { CanvasStore } from './canvasStore.js'
import { startLocalWork } from './localWorkPlaceholder.js'
import { pendingRemoval } from './pendingRemoval.js'

// ⚠️ Жалобы 01.10.2026 со снимками: «пытаюсь удалить картинку, а он пишет
// предупреждение — причём эта картинка появляется после кропа» и «генерация
// зависла, и её никак не убрать». Любая крутящаяся карточка считалась идущей
// генерацией: Delete её не убирал, а «Остановить» шло в задачу, которой нет.

const NOW = 1_800_000_000_000
const card = (extra: Record<string, unknown> = {}) => ({
  status: 'loading' as const, startedAt: NOW - 5_000, ...extra,
})
const unknown = () => undefined

test('карточка своей работы убирается сразу — это не генерация', () => {
  assert.equal(pendingRemoval(card({ transient: true, jobId: 'local:crop' }), NOW, unknown), 'remove')
})

test('идущую генерацию Delete не убирает: её сперва останавливают', () => {
  assert.equal(pendingRemoval(card({ jobId: 'cloud-job~prj_1~job_1' }), NOW, () => 'running'), 'running-generation')
  assert.equal(pendingRemoval(card({ jobId: 'cloud-job~prj_1~job_1' }), NOW, () => 'cancelling'), 'running-generation')
})

test('генерация коллеги, о которой вкладка не знает, считается живой', () => {
  assert.equal(pendingRemoval(card({ jobId: 'cloud-job~prj_1~job_2' }), NOW, unknown), 'running-generation')
})

test('карточка законченной задачи убирается: ждать ей нечего', () => {
  for (const state of ['done', 'error', 'cancelled'] as const) {
    assert.equal(pendingRemoval(card({ jobId: 'cloud-job~prj_1~job_1' }), NOW, () => state), 'remove', state)
  }
})

test('скачивание по ссылке останавливается своей кнопкой', () => {
  assert.equal(pendingRemoval(card({ jobId: 'import-1', taskType: 'media-import' }), NOW, unknown), 'running-import')
})

test('запуск без номера задачи: сперва ждём, потом карточку можно убрать', () => {
  assert.equal(pendingRemoval(card(), NOW, unknown), 'launching')
  const stale = card({ startedAt: NOW - ORPHAN_LAUNCH_AFTER_MS - 1 })
  assert.equal(pendingRemoval(stale, NOW, unknown), 'remove', '«Запуск прервался» убирается и клавишей')
})

test('упавшая карточка и пометка «задачи на сервере нет» убираются', () => {
  assert.equal(pendingRemoval({ status: 'error', startedAt: NOW }, NOW, unknown), 'remove')
  assert.equal(pendingRemoval(card({ jobId: 'local:launch-failed' }), NOW, unknown), 'remove')
})

test('Delete убирает карточку обрезки, а работа после этого на доску не встаёт', async () => {
  const store = new CanvasStore()
  const work = startLocalWork(store, {
    label: 'Crop',
    rect: { x: 0, y: 0, w: 200, h: 100 },
    preview: { previewSrc: '/media/source.png' },
  })
  const [crop] = store.getPending()
  assert.ok(crop?.transient)
  assert.equal(work.dropped(), false)

  store.removeItems([crop!.id])
  assert.deepEqual(store.getPending(), [], 'карточка ушла с первого нажатия')
  assert.equal(work.dropped(), true, 'работа знает, что от неё отказались')

  await work.done({ url: '/media/crop.png', mime: 'image/png', width: 200, height: 100 }, 'обрезка')
  assert.deepEqual(store.getItems(), [], 'опоздавший результат карточку не воскрешает')
})

test('идущая генерация остаётся на месте и после Delete', () => {
  const store = new CanvasStore()
  const [slot] = store.addPendingRow(1, { kind: 'image', label: 'GPT Image 2.5 Sunburst' })
  store.setPendingJob(slot!, 'cloud-job~prj_1~job_чужая')
  store.removeItems([slot!])
  assert.deepEqual(store.getPending().map((pending) => pending.id), [slot])
})
