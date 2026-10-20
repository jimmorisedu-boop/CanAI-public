import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { scheduleFocusRestore } from './TabletPopover.js'
import { TabletClipFeedback } from './TabletClip.js'
import { fitCropPreview } from './cropViewModel.js'
import { tabletSystemMessage } from './tabletSystemMessage.js'
import { resizeFromCorner, resizeFromEdge } from '../spaces/canvas/konva/cropMath.js'
import { clearTimelineNotice, getTimelineNotice, notifyInTimeline } from '../spaces/canvas/timeline/timelineNotice.js'
import { setTimelineTarget } from '../spaces/canvas/timeline/timelineBus.js'

test('tablet frame capture uses the explicit board uploader, never the desktop global target', async () => {
  const source = fs.readFileSync(new URL('../spaces/canvas/timeline/captureFrame.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('captureFrame.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureVideoFrameAt')!
  const code = ts.transpile(declaration.getText(tree).replace(/^export /, ''), { target: ts.ScriptTarget.ES2022 })
  let uploaded = 0
  let legacy = 0
  const notices: unknown[] = []
  const upload = async () => { uploaded++; return { assetId: 'ast_frame', url: '/v3/assets/ast_frame', mime: 'image/png' } }
  const capture = new Function('frameBlob', 'captureFrameToCanvas', 'boardMediaUploader', 'notifyInTimeline', code + '\nreturn captureVideoFrameAt')(
    async () => ({ blob: new Blob(['frame']), width: 20, height: 10 }),
    async (_store: unknown, _item: unknown, produce: () => Promise<unknown>, uploader: typeof upload) => { await produce(); const result = await uploader(); assert.equal(result.assetId, 'ast_frame'); return 'frame' },
    () => { legacy++; throw new Error('desktop uploader must not run') },
    (notice: unknown) => notices.push(notice),
  )
  await capture({ removeItems() {} }, { id: 'video', src: '/v3/assets/ast_video' }, 0, null, upload)
  assert.equal(uploaded, 1)
  assert.equal(legacy, 0)
  assert.equal((notices[0] as {kind: string}).kind, 'success')
})

// Runs the actual async callbacks without mounting a browser or invoking ffmpeg.
function callback(relative: string, variable: string): string {
  const file = new URL(relative, import.meta.url)
  const source = ts.createSourceFile(file.pathname, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let arrow: ts.ArrowFunction | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === variable && node.initializer) {
      const value = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer
      if (value && ts.isArrowFunction(value)) arrow = value
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(arrow)
  return ts.transpile(`const callback = ${arrow.getText(source)}`, { target: ts.ScriptTarget.ES2022 }) + '\nreturn callback'
}

for (const outcome of ['failure', 'empty', 'empty-result', 'success'] as const) {
  test(`clip apply: ${outcome} closes only after a created result`, async () => {
    let closed = 0
    let created = 0
    const notices: Array<{ kind: string }> = []
    // ⚠️ Зависимости внедряются поимённо: забыл новую — функция падает на
    // неизвестном имени, и тест краснеет не по делу. adoptForBoard переселяет
    // куски нарезки на сервер команды (см. boardUploader).
    const apply = new Function('item', 'kept', 'applyingRef', 'setBusy', 'notifyInTimeline', 'api', 'crop', 'store', 'setTimelineTarget', 'pluralPieces', 'adoptForBoard',
      callback('../spaces/canvas/timeline/useTimelineSession.ts', 'apply'))(
      { src: '/media/test.mp4' }, outcome === 'empty' ? [] : [{ start: 1, end: 2 }], { current: false }, () => {}, (notice: { kind: string }) => notices.push(notice),
      { cutVideo: async () => { if (outcome === 'failure') throw new Error('503'); return { pieces: outcome === 'empty-result' ? [] : [{}] } } }, null,
      { placeVideoPieces: () => { created++; return ['piece'] }, removeItems() {} }, () => {}, () => '',
      async (piece: unknown) => piece,
    )
    const tabletApply = new Function('applyingRef', 'setBusyNote', 'session', 'onClose',
      callback('./TabletClip.tsx', 'apply'))({ current: false }, () => {}, { apply }, () => closed++)
    await tabletApply()
    assert.equal(closed, outcome === 'success' ? 1 : 0)
    assert.equal(created, outcome === 'success' ? 1 : 0)
    if (outcome === 'failure') assert.ok(notices.some(notice => notice.kind === 'error'))
  })
}

test('popover restore does not steal the focus of a newly opened editor', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const input = { isConnected: true }
  const body = {}
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: input, body } })
  try {
    let restored = false
    scheduleFocusRestore({ focus: () => { restored = true } }, run => run())
    assert.equal(restored, false)
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

for (const discard of [false, true]) {
  test(`discard ${discard}: a new text placeholder is removed only by confirmed cancellation`, async () => {
    let closed = 0
    let removed = 0
    let askedDirty = false
    const close = new Function('created', 'text', 'size', 'initialText', 'initialSize', 'store', 'itemId', 'onClose', 'confirmDiscardDraft',
      callback('./TabletTextEditor.tsx', 'close'))(
      { current: true }, 'Черновик', 15, '', 15,
      { removeItems() { removed++ } }, 'text', () => closed++, async (dirty: boolean) => { askedDirty = dirty; return discard },
    )
    await close()
    assert.equal(askedDirty, true)
    assert.equal(closed, Number(discard))
    assert.equal(removed, Number(discard))
  })
  test(`discard ${discard}: Sketch and Crop keep draft state until permission`, async () => {
    let closed = 0
    let cleared = 0
    const decisions: boolean[] = []
    const confirm = async (dirty: boolean) => { decisions.push(dirty); return discard }
    const sketchClose = new Function('busyRef', 'confirmDiscardDraft', 'strokes', 'promptDirty', 'store', 'onClose',
      callback('./TabletSketch.tsx', 'close'))({ current: false }, confirm, [{}], false,
      { clearStrokes() { cleared++ } }, () => closed++)
    const cropClose = new Function('busyRef', 'discardPromptRef', 'rect', 'bounds', 'confirmDiscardDraft', 'onClose',
      callback('./TabletCrop.tsx', 'close'))({ current: false }, { current: false }, { x: 10, y: 0, w: 80, h: 100 }, { w: 100, h: 100 }, confirm, () => closed++)
    await sketchClose(); await cropClose()
    assert.deepEqual(decisions, [true, true])
    assert.equal(closed, Number(discard) * 2)
    assert.equal(cleared, Number(discard))
  })
}

test('Sketch close considers a typed prompt even when the picture has no strokes', async () => {
  let closed = 0
  let dirty = false
  const close = new Function('busyRef', 'confirmDiscardDraft', 'strokes', 'promptDirty', 'store', 'onClose',
    callback('./TabletSketch.tsx', 'close'))({ current: false }, async (value: boolean) => { dirty = value; return !value }, [], true,
    { clearStrokes() {} }, () => closed++)
  await close()
  assert.equal(dirty, true)
  assert.equal(closed, 0)
})

test('dirty text stays open when discarding was not confirmed', async () => {
  let closed = 0
  const close = new Function('created', 'text', 'size', 'initialText', 'initialSize', 'store', 'itemId', 'onClose', 'confirmDiscardDraft',
    callback('./TabletTextEditor.tsx', 'close'))(
    { current: false }, 'Изменённый черновик', 15, 'Исходный', 15,
    { removeItems() {} }, 'text', () => closed++, async () => false,
  )
  await close()
  assert.equal(closed, 0)
})

test('crop preview reserves a touch margin for every handle and zoom changes view only', () => {
  const bounds = { w: 400, h: 800 }
  const viewport = { w: 600, h: 700 }
  const fit = fitCropPreview(bounds, viewport, 30, 1)
  const zoomed = fitCropPreview(bounds, viewport, 30, 0.5)

  assert.equal(fit.scale, 0.8)
  assert.equal(fit.w, 320)
  assert.equal(fit.h, 640)
  assert.ok((viewport.w - fit.w) / 2 >= 30)
  assert.ok((viewport.h - fit.h) / 2 >= 30)
  assert.equal(zoomed.w, fit.w / 2)
  assert.equal(zoomed.h, fit.h / 2)
  assert.equal(zoomed.scale, fit.scale / 2)
})

test('crop pointer resizing keeps the pointerdown frame as its baseline across renders', () => {
  const initial = { x: 20, y: 30, w: 180, h: 140 }
  const bounds = { w: 400, h: 400 }
  const drag = { current: { handle: 'nw' as const, from: { x: 20, y: 30 }, start: initial } }
  const calls: Array<{ kind: 'corner' | 'edge'; rect: typeof initial }> = []
  const updates: typeof initial[] = []
  const setRect = (value: typeof initial) => { updates.push(value); return value }
  const points = [{ x: 80, y: 70 }, { x: 50, y: 55 }]
  let pointIndex = 0
  const pointOf = () => points[pointIndex++]!
  const corner = (rect: typeof initial, handle: 'nw' | 'ne' | 'sw' | 'se', point: { x: number; y: number }, passedBounds: typeof bounds, passedRatio: number | null) => {
    calls.push({ kind: 'corner', rect })
    return resizeFromCorner(rect, handle, point, passedBounds, passedRatio)
  }
  const edge = (rect: typeof initial, handle: 'n' | 's' | 'w' | 'e', point: { x: number; y: number }, passedBounds: typeof bounds) => {
    calls.push({ kind: 'edge', rect })
    return resizeFromEdge(rect, handle, point, passedBounds)
  }
  const move = (renderRect: typeof initial) => new Function(
    'drag', 'pointOf', 'setRect', 'rect', 'bounds', 'ratio',
    'resizeFromCorner', 'resizeFromEdge', 'CORNERS',
    callback('./TabletCrop.tsx', 'onMove'),
  )(
    drag, pointOf, setRect, renderRect, bounds, null,
    corner, edge,
    ['nw', 'ne', 'sw', 'se'],
  )

  move(initial)({})
  // Simulate React committing the first move and returning a new event
  // handler closure before the second pointermove arrives.
  move({ x: 60, y: 40, w: 140, h: 130 })({})
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.kind, 'corner')
  assert.equal(calls[0]?.rect, initial)
  assert.equal(calls[1]?.rect, initial)
  assert.deepEqual(updates[1], resizeFromCorner(initial, 'nw', points[1]!, bounds, null))
})

test('clean crop cancellation closes without opening a confirmation', async () => {
  let asked = 0
  let closed = 0
  const close = new Function('busyRef', 'discardPromptRef', 'rect', 'bounds', 'confirmDiscardDraft', 'onClose',
    callback('./TabletCrop.tsx', 'close'))(
      { current: false }, { current: false }, { x: 0, y: 0, w: 100, h: 80 }, { w: 100, h: 80 },
      async () => { asked++; return true }, () => { closed++ },
    )

  await close()
  assert.equal(asked, 0)
  assert.equal(closed, 1)
})

test('repeated dirty crop cancellation taps share one confirmation and one close', async () => {
  let asked = 0
  let closed = 0
  let settle!: (answer: boolean) => void
  const answer = new Promise<boolean>((resolve) => { settle = resolve })
  const close = new Function('busyRef', 'discardPromptRef', 'rect', 'bounds', 'confirmDiscardDraft', 'onClose',
    callback('./TabletCrop.tsx', 'close'))(
      { current: false }, { current: false }, { x: 10, y: 0, w: 90, h: 80 }, { w: 100, h: 80 },
      async () => { asked++; return answer }, () => { closed++ },
    )

  const first = close()
  const second = close()
  await Promise.resolve()
  assert.equal(asked, 1)
  settle(true)
  await Promise.all([first, second])
  assert.equal(closed, 1)
})

test('crop upload failure releases the busy lock so the user can retry', async () => {
  const busyStates: boolean[] = []
  const errors: string[] = []
  const upstreamError = 'Сеть недоступна'
  let attempts = 0
  let closed = 0
  // Обрезка идёт фоном (пункт 3.6): экран закрывается, как только кусок
  // вырезан, а сбой ДО этого — ошибка на экране, как раньше.
  const apply = new Function('busyRef', 'setBusy', 'setError', 'rect', 'bounds', 'applyCropInBackground', 'store', 'item', 'upload', 'onClose', 'notify', 'tabletSystemMessage',
    callback('./TabletCrop.tsx', 'apply'))(
      { current: false }, (value: boolean) => busyStates.push(value), (value: string | null) => { if (value) errors.push(value) },
      { x: 0, y: 0, w: 60, h: 80 }, { w: 100, h: 80 },
      async () => { attempts++; if (attempts === 1) throw new Error(upstreamError) }, {}, { id: 'image', w: 100, h: 80 }, {}, () => { closed++ },
      () => {}, tabletSystemMessage,
    )

  await apply()
  assert.deepEqual(busyStates, [true, false])
  assert.deepEqual(errors, [tabletSystemMessage(upstreamError)])
  await apply()
  assert.deepEqual(busyStates, [true, false, true, false])
  assert.equal(closed, 1)
})

test('crop uses a dedicated stylesheet and keeps exact fields behind an optional disclosure', () => {
  const crop = fs.readFileSync(new URL('./TabletCrop.tsx', import.meta.url), 'utf8')
  const css = fs.readFileSync(new URL('./tabletCrop.css', import.meta.url), 'utf8')
  const entry = fs.readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  assert.match(entry, /import ['"]\.\/tabletCrop\.css['"]/)
  assert.match(crop, /Exact dimensions/)
  assert.match(crop, /<details[^>]*tablet-crop-precise/)
  assert.match(css, /\.tablet-crop-stage/)
})

test('clip More disclosure owns Escape before the modal dismissal handler', () => {
  const clip = fs.readFileSync(new URL('./TabletClip.tsx', import.meta.url), 'utf8')
  assert.match(clip, /window\.addEventListener\('keydown', onKeyDown, true\)/)
  assert.match(clip, /event\.preventDefault\(\)[\s\S]{0,80}event\.stopPropagation\(\)/)
  assert.match(clip, /aria-controls="tablet-clip-more"/)
})

test('confirmation host joins the tablet modal stack and renders above the editor', () => {
  const host = fs.readFileSync(new URL('../ui/ConfirmHost.tsx', import.meta.url), 'utf8')
  assert.match(host, /useModalFocus/)
  assert.match(host, /Boolean\(pending\)/)
  assert.match(host, /confirm-modal-backdrop/)
})

test('failed clip apply is an accessible inline error inside the editor, with its montage still open', async () => {
  let closed = 0
  const upstreamError = '503 — повторите обработку'
  setTimelineTarget('test-video')
  try {
    const apply = new Function('item', 'kept', 'applyingRef', 'setBusy', 'notifyInTimeline', 'api', 'crop', 'store', 'setTimelineTarget', 'pluralPieces',
      callback('../spaces/canvas/timeline/useTimelineSession.ts', 'apply'))(
      { src: '/media/test.mp4' }, [{ start: 1, end: 2 }], { current: false }, () => {}, notifyInTimeline,
      { cutVideo: async () => { throw new Error(upstreamError) } }, null,
      { placeVideoPieces() { assert.fail('a failed request must not create media') } }, setTimelineTarget, () => '',
    )
    const tabletApply = new Function('applyingRef', 'setBusyNote', 'session', 'onClose',
      callback('./TabletClip.tsx', 'apply'))({ current: false }, () => {}, { apply }, () => closed++)
    await tabletApply()
    const html = renderToStaticMarkup(createElement(TabletClipFeedback, { error: null }))
    assert.match(html, /role="alert"/)
    assert.equal(getTimelineNotice()?.message, upstreamError)
    assert.match(html, /Clip editing failed\./)
    assert.doesNotMatch(html, /503 — повторите обработку/)
    assert.equal(closed, 0)
    const directError = 'Видео не прочитано: сеть недоступна'
    const directHtml = renderToStaticMarkup(createElement(TabletClipFeedback, { error: directError }))
    assert.match(directHtml, /Clip editing failed\./)
    assert.doesNotMatch(directHtml, /Видео не прочитано: сеть недоступна/)
  } finally {
    clearTimelineNotice()
    setTimelineTarget(null)
  }
})
