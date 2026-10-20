import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { CanvasStore } from './canvasStore.js'
import { adoptForBoard, adoptResultForBoard } from './boardUploader.js'

// Execute the small drop handler without mounting the whole React shelf.
async function handler(file: string, name: string, deps: Record<string, unknown>) {
  const source = ts.createSourceFile(
    file,
    await readFile(new URL(file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let found: ts.FunctionDeclaration | undefined
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(found, name)
  const js = ts.transpileModule(found.getText(source).replace(/^export /u, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(deps), `${js}; return ${name}`)(...Object.values(deps))
}

test('медленная загрузка в локальные ассеты молчит до успеха, а ошибка не теряется', async () => {
  for (const failed of [false, true]) {
    const store = new CanvasStore()
    const notices: unknown[] = []
    const busy: Array<number | null> = []
    let finish!: (value: unknown) => void
    let fail!: (error: Error) => void
    const uploading = new Promise((resolve, reject) => { finish = resolve; fail = reject })
    const drop = await handler('../AssetBar.tsx', 'onDropFile', {
      store,
      setBusySlot: (slot: number | null) => busy.push(slot),
      measure: async () => ({ w: 640, h: 480, readable: true }),
      boardMediaUploader: () => () => uploading,
      notify: (notice: unknown) => notices.push(notice),
    })
    const pending = drop(0, {
      preventDefault() {},
      stopPropagation() {},
      dataTransfer: { files: [{ type: 'image/png', name: 'test.png' }] },
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(notices, [])
    assert.deepEqual(busy, [0])
    assert.equal(store.getAssets().length, 0)
    if (failed) fail(new Error('Локальное хранилище недоступно'))
    else finish({ url: '/media/uploaded.png', mime: 'image/png' })
    await pending
    assert.deepEqual(busy, [0, null])
    if (failed) {
      assert.equal(store.getAssets().length, 0)
      assert.equal(notices.length, 1)
      assert.equal((notices[0] as { kind: string }).kind, 'error')
    } else {
      assert.deepEqual(notices, [])
      assert.equal(store.getAssets()[0]?.src, '/media/uploaded.png')
    }
  }
})

test('битый файл в локальные ассеты не берут и на сервер не шлют', async () => {
  const store = new CanvasStore()
  const notices: Array<{ kind: string; message: string }> = []
  let uploads = 0
  const drop = await handler('../AssetBar.tsx', 'onDropFile', {
    store,
    setBusySlot: () => {},
    measure: async () => ({ w: 1024, h: 768, readable: false }),
    boardMediaUploader: () => () => { uploads += 1; return Promise.resolve({ url: '/media/x', mime: 'image/png' }) },
    notify: (notice: { kind: string; message: string }) => notices.push(notice),
  })
  await drop(0, {
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { files: [{ type: 'image/png', name: 'заметка.png' }] },
  })
  assert.equal(store.getAssets().length, 0)
  assert.equal(uploads, 0, 'file that cannot be rendered is not uploaded')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].kind, 'error')
  assert.ok(notices[0].message.includes('"заметка.png"'))
})

test('локальная доска оставляет уже сохранённые media ссылки на месте', async () => {
  const media = { url: '/media/a.mp3', mime: 'audio/mpeg' }
  assert.deepEqual(await adoptForBoard(media, 'a.mp3', { source: 'local', id: 'p1' }), media)
  assert.deepEqual(await adoptForBoard(media, 'a.mp3', null), media)
  assert.deepEqual(
    await adoptResultForBoard({ url: '/media/a.png', mime: 'image/png' }, 'a.png', { source: 'local', id: 'p1' }),
    { url: '/media/a.png', mime: 'image/png' },
  )
})

test('локальные операции канваса используют общий media uploader', async () => {
  const uploader = await readFile(new URL('./boardUploader.ts', import.meta.url), 'utf8')
  assert.match(uploader, /return api\.uploadFile/)
  assert.doesNotMatch(uploader, /cloudAssetTransport|cloud-assets|BoardCollaboration/)

  const space = await readFile(new URL('../CanvasSpace.tsx', import.meta.url), 'utf8')
  assert.match(space, /boardMediaUploader\(projectRef\)/)
})
