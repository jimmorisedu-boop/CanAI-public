import assert from 'node:assert/strict'
import test from 'node:test'
import { isLostLocalLaunch, isOrphanedLaunch, ORPHAN_LAUNCH_AFTER_MS } from './pendingLaunchState.js'

test('карточка без номера задачи старше получаса — брошенный запуск', () => {
  const startedAt = 1_000_000
  const late = startedAt + ORPHAN_LAUNCH_AFTER_MS + 1
  assert.equal(isOrphanedLaunch({ status: 'loading', startedAt }, late), true)
  assert.equal(isOrphanedLaunch({ status: 'loading', startedAt }, startedAt + 60_000), false,
    'номер приходит через секунды — свежий запуск не трогаем')
  assert.equal(isOrphanedLaunch({ status: 'loading', startedAt, jobId: 'cloud-job~prj_1~job_1' }, late), false,
    'с номером за задачей следит опрос')
  assert.equal(isOrphanedLaunch({ status: 'error', startedAt }, late), false)
  assert.equal(isOrphanedLaunch({ status: 'loading', startedAt, transient: true }, late), false,
    'местная работа живёт в своей вкладке')
  assert.equal(isOrphanedLaunch({ status: 'loading', startedAt, taskType: 'media-import' }, late), false)
})

test('сохранённый запуск без задачи сервера считается потерянным', () => {
  assert.equal(isLostLocalLaunch({ status: 'loading', jobId: 'local:launch-1' }), true)
})

test('заглушка идущей местной работы потерянной не считается', () => {
  // startLocalWork: скетч, обрезка, кадр из клипа — работа ещё идёт в этой вкладке.
  assert.equal(isLostLocalLaunch({ status: 'loading', jobId: 'local:work-1', transient: true }), false)
})

test('скачивание по ссылке, задачи сервера и закончившиеся карточки не трогаем', () => {
  assert.equal(isLostLocalLaunch({ status: 'loading', jobId: 'local:import-1', taskType: 'media-import' }), false)
  assert.equal(isLostLocalLaunch({ status: 'loading', jobId: 'cloud-job~prj_1~job_1' }), false)
  assert.equal(isLostLocalLaunch({ status: 'error', jobId: 'local:launch-1' }), false)
})
