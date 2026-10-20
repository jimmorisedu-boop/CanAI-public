// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { CanvasStore } from './canvasStore'
import { mediaKind } from './clipboardMedia'
import { layoutMediaGrid } from './mediaGridLayout'
import { AUDIO_ITEM_HEIGHT, AUDIO_ITEM_WIDTH } from './audioMeta'

// Импорт стоит на браузерных декодерах (<img>, <video>), поэтому настоящий
// модуль исполняется в песочнице с подставленными Image и video: правило
// «нечитаемый файл на доску не ложится» — про поведение, и подтвердить его
// можно только прогоном.
function sandbox(readable: string[]) {
  const uploaded: string[] = []
  // Операции загрузки: «Повторить» в панели загрузок зовёт ту же операцию снова.
  const operations = []
  // Какой файл сейчас меряют: measure зовёт createObjectURL и следом создаёт
  // элемент, между этими двумя строками ничего не вклинивается.
  let current = ''
  const pending: string[] = []
  function element() {
    const ok = readable.includes(current)
    return {
      naturalWidth: 640, naturalHeight: 480, videoWidth: 640, videoHeight: 480,
      onload: null, onerror: null, onloadedmetadata: null,
      set src(_value) { queueMicrotask(() => (ok ? (this.onload ?? this.onloadedmetadata)?.() : this.onerror?.())) },
    }
  }
  const globals = {
    URL: { createObjectURL: () => { current = pending.shift() ?? ''; return 'blob:' + current }, revokeObjectURL() {} },
    queueMicrotask,
    Image: function Image() { return element() },
    document: { createElement: () => element() },
  }
  const source = fs.readFileSync(new URL('./importMedia.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    fileName: 'importMedia.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const mocks = {
    '../../../api': { api: {
      uploadFile: async (file) => { uploaded.push(file.name); return { url: '/media/' + file.name, mime: file.type } },
      audioPeaks: async () => ({ peaks: [] }),
    } },
    '../importQueue': { startImport: (_file, run) => { operations.push(run); return run(new AbortController().signal, () => {}) } },
    './clipboardMedia': { mediaKind },
    './mediaGridLayout': { layoutMediaGrid },
    './audioMeta': { AUDIO_ITEM_HEIGHT, AUDIO_ITEM_WIDTH },
  }
  const exports = {}
  vm.runInNewContext(code, { exports, require: name => mocks[name] ?? {}, ...globals }, { filename: 'importMedia.ts' })
  return {
    uploaded,
    retry(index) {
      return operations[index](new AbortController().signal, () => {})
    },
    importFiles(store, files, projectRef) {
      pending.length = 0
      pending.push(...files.map(file => file.name))
      return exports.importFilesAt(store, files, { x: 0, y: 0 }, {}, undefined, projectRef)
    },
  }
}

const board = store => store.getItems().map(item => item.name)

test('битый файл не ложится на доску и объясняет себя по имени', async () => {
  const box = sandbox([])
  const store = new CanvasStore()
  await assert.rejects(
    () => box.importFiles(store, [{ name: 'заметка.png', type: 'image/png', size: 12 }]),
    error => error.message.includes('«заметка.png»') && error.message.includes('could not be opened'),
  )
  assert.deepEqual(board(store), [], 'пустой карточке на доске не место')
  assert.deepEqual(box.uploaded, [], 'и на сервер такой файл не уезжает')
})

test('целые файлы партии доезжают, битый называется отдельно', async () => {
  const box = sandbox(['кадр.png'])
  const store = new CanvasStore()
  await assert.rejects(
    () => box.importFiles(store, [
      { name: 'кадр.png', type: 'image/png', size: 10 },
      { name: 'мусор.jpg', type: 'image/jpeg', size: 10 },
    ]),
    error => error.message.includes('«мусор.jpg»'),
  )
  assert.deepEqual(board(store), ['кадр.png'])
  const [placed] = store.getItems()
  assert.equal(Math.round((placed.w / placed.h) * 100), 133, 'пропорции берутся у прочитанного кадра, а не у запасных 1024×768')
  assert.deepEqual(box.uploaded, ['кадр.png'])
})
