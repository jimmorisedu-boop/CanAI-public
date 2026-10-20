import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore.js'
import { bindMacroRunToBoard, dismissUnusedSlots, type MacroRunState } from '../macroRunClient.js'

test('текст задачи сохраняет sourceJobId и повторная доставка не создаёт дубль', async () => {
  const store = new CanvasStore()
  const [slot] = store.addPendingRow(1, { kind: 'text', label: 'Текст' })
  store.setPendingJob(slot, 'macro-text-result')
  await store.resolveJob('macro-text-result', { text: 'Результат заметки' }, 'Текст')
  const first = store.getItems()
  assert.equal(first.length, 1)
  assert.equal(first[0].sourceJobId, 'macro-text-result')
  assert.equal(first[0].text, 'Результат заметки')
  await store.resolveJob('macro-text-result', { text: 'Результат заметки' }, 'Текст')
  assert.equal(store.getItems().length, 1)
  assert.equal(store.getPending().length, 0)
})

test('доставка текста без сохранённой заглушки тоже сохраняет принадлежность задаче', async () => {
  const store = new CanvasStore()
  await store.resolveJob('macro-no-slot', { text: 'Готово' }, 'Текст')
  assert.equal(store.getItems()[0].sourceJobId, 'macro-no-slot')
  assert.deepEqual(store.findGenerationResults(['macro-no-slot']).missingJobIds, [])
})

test('открытая доска связывает готовый выход макроса с доставкой текста', async () => {
  const store = new CanvasStore()
  const [slot] = store.addPendingRow(1, { kind: 'text', label: 'Макрос' })
  const run: MacroRunState = {
    id: 'run-1', macroId: 'macro-1', macroName: 'Текст', projectId: 'board-1',
    status: 'done', startedAt: 0, delivered: 1,
    placeholderIds: [slot], placeholderByNode: { note: slot },
    nodes: { note: { status: 'done', jobId: 'macro-output-job' } },
  }
  const bound = new Set<string>()
  assert.deepEqual(bindMacroRunToBoard(run, store, bound), ['macro-output-job'])
  dismissUnusedSlots(run, store)
  assert.equal(store.getPending()[0].jobId, 'macro-output-job')
  await store.resolveJob('macro-output-job', { text: 'Заметка' }, 'Текст')
  assert.equal(store.getItems()[0].sourceJobId, 'macro-output-job')
  assert.deepEqual(bindMacroRunToBoard(run, store, bound), [])
  store.archiveItems([store.getItems()[0].id])
  await store.resolveJob('macro-output-job', { text: 'Заметка' }, 'Текст')
  assert.equal(store.getItems().length, 0, 'Повтор не возвращает отправленный в архив результат')
  assert.equal(store.findGenerationResults(['macro-output-job']).archivedIds.length, 1)
})

test('готовое видео без заглушки сохраняет sourceJobId и не дублируется', async () => {
  const store = new CanvasStore()
  const result = { url: '/media/ready.mp4', mime: 'video/mp4', width: 1280, height: 720 }
  await store.resolveJob('macro-video', result, 'Видео')
  assert.equal(store.getItems()[0].sourceJobId, 'macro-video')
  await store.resolveJob('macro-video', result, 'Видео')
  assert.equal(store.getItems().length, 1)
})
