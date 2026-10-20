// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import type { GenerationTask, GenerationTaskState } from './generationRegistry'
import type { GenerationLaunchMeta } from './generationLaunches'
import { taskAnnouncement } from './taskAnnouncements'

const task = (
  jobId: string,
  state: GenerationTaskState,
  error?: string,
  launch?: GenerationLaunchMeta,
): GenerationTask => ({
  jobId,
  jobKind: 'image',
  target: { kind: 'canvas', projectId: 'p' },
  state,
  error,
  launch,
  createdAt: 0,
})

const launch = (variantIndex: number, variantCount = 4): GenerationLaunchMeta => ({
  launchId: 'launch-1',
  variantIndex,
  variantCount,
  projectId: 'p',
  promptPreview: 'Берег',
  modelName: 'GPT Image 2',
  createdAt: 1,
})

test('готовый результат объявляется', () => {
  const said = taskAnnouncement([task('a', 'running')], [task('a', 'done')])
  assert.equal(said, 'Done: 1 result')
})

test('несколько задач за один тик дают ОДНУ фразу, а не перебивают друг друга', () => {
  const before = [task('a', 'running'), task('b', 'running'), task('c', 'running')]
  const after = [task('a', 'done'), task('b', 'done'), task('c', 'error', 'нет связи')]
  const said = taskAnnouncement(before, after)
  assert.equal(said, 'Done: 2 results, Error: Connection lost.')
})

test('одна ошибка называет причину, несколько — считаются', () => {
  assert.match(
    taskAnnouncement([task('a', 'running')], [task('a', 'error', 'модель отказала')]) ?? '',
    /Request failed\. Open the diagnostic log for details\./,
  )
  const many = taskAnnouncement(
    [task('a', 'running'), task('b', 'running')],
    [task('a', 'error', 'раз'), task('b', 'error', 'два')],
  )
  assert.equal(many, 'Failed: 2 tasks')
})

test('ошибка без текста всё равно объявляется человеческой фразой', () => {
  assert.equal(
    taskAnnouncement([task('a', 'running')], [task('a', 'error')]),
    'Error: generation failed',
  )
})

test('пока часть задач идёт, об этом говорится — иначе «готово» звучит как конец всего', () => {
  const said = taskAnnouncement(
    [task('a', 'running'), task('b', 'running')],
    [task('a', 'done'), task('b', 'running')],
  )
  assert.equal(said, 'Done: 1 result, 1 task still in progress')
})

// Реестр переживает смену доски: при возврате готовые задачи приезжают уже
// финальными. Объявить их — значит прочитать вслух вчерашнюю историю.
test('задачи, чей переход мы не видели, не объявляются', () => {
  assert.equal(taskAnnouncement([], [task('a', 'done'), task('b', 'error', 'x')]), null)
})

test('идущая задача молчит, пока не кончится', () => {
  assert.equal(taskAnnouncement([task('a', 'queued')], [task('a', 'running')]), null)
})

test('отмена объявляется отдельно от ошибки', () => {
  assert.equal(
    taskAnnouncement([task('a', 'cancelling')], [task('a', 'cancelled')]),
    'Cancelled: 1 task',
  )
})

test('четыре готовых варианта одного запуска дают одно агрегированное объявление', () => {
  const fingerprints = new Map<string, string>()
  const before = [1, 2, 3, 4].map((index) => task(`j${index}`, 'running', undefined, launch(index)))
  taskAnnouncement([], before, fingerprints)
  const after = [1, 2, 3, 4].map((index) => task(`j${index}`, 'done', undefined, launch(index)))

  assert.equal(taskAnnouncement(before, after, fingerprints), '4 of 4 ready')
})

test('частичный запуск объявляет общий итог один раз и помечает ошибку как приоритетную', () => {
  const fingerprints = new Map<string, string>()
  const before = [1, 2, 3, 4].map((index) => task(`j${index}`, 'running', undefined, launch(index)))
  taskAnnouncement([], before, fingerprints)
  const after = [
    task('j1', 'done', undefined, launch(1)),
    task('j2', 'done', undefined, launch(2)),
    task('j3', 'done', undefined, launch(3)),
    task('j4', 'error', 'Нет связи', launch(4)),
  ]

  assert.equal(
    taskAnnouncement(before, after, fingerprints),
    '3 of 4 ready, one option with an error',
  )
  assert.equal(taskAnnouncement(after, after, fingerprints), null)
})
