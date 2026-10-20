import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import { readFileSync } from 'node:fs'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { zoomAt, zoomTo100, zoomToFit } from './cameraOps'
import { CanvasStore } from './canvasStore'
import { pointerToWorld } from './canvasPointer'

test('до первого движения указателя канвас не подставляет мировую точку 0,0', () => {
  assert.equal(pointerToWorld(null, { x: -500, y: -300, scale: 2 }), undefined)
})

test('позиция указателя переводится из экранных координат в мировые', () => {
  assert.deepEqual(
    pointerToWorld({ x: 700, y: 500 }, { x: -500, y: -300, scale: 2 }),
    { x: 600, y: 400 },
  )
})

test('ручное управление камерой имеет отдельную версию и будит только manual-подписчиков', () => {
  const store = new CanvasStore()
  let manualEvents = 0
  let cameraEvents = 0
  let contentEvents = 0
  let documentEvents = 0
  const unsubscribeManual = store.subscribeManualCamera(() => manualEvents++)
  const unsubscribeCamera = store.subscribeCamera(() => cameraEvents++)
  const unsubscribeContent = store.subscribeContent(() => contentEvents++)
  const unsubscribeDocument = store.subscribeDocument(() => documentEvents++)

  store.setCamera({ x: 15, y: -8, scale: 1.25 })
  assert.deepEqual(
    { manualEvents, cameraEvents, contentEvents, documentEvents, manualVersion: store.getManualCameraVersion() },
    { manualEvents: 0, cameraEvents: 1, contentEvents: 0, documentEvents: 0, manualVersion: 0 },
  )

  store.noteManualCameraInteraction()
  assert.deepEqual(
    { manualEvents, cameraEvents, contentEvents, documentEvents, manualVersion: store.getManualCameraVersion() },
    { manualEvents: 1, cameraEvents: 1, contentEvents: 0, documentEvents: 0, manualVersion: 1 },
  )
  assert.equal('manualCameraVersion' in store.toDoc(), false)

  unsubscribeManual()
  unsubscribeCamera()
  unsubscribeContent()
  unsubscribeDocument()
  store.noteManualCameraInteraction()
  assert.equal(manualEvents, 1)
  assert.equal(store.getManualCameraVersion(), 2)
})

test('каждая пользовательская zoom-команда посылает ровно один manual-сигнал', () => {
  const store = new CanvasStore()
  let manualEvents = 0
  store.subscribeManualCamera(() => manualEvents++)

  zoomAt(store, { x: 100, y: 80 }, 1.5)
  assert.equal(manualEvents, 1)
  zoomTo100(store, { w: 800, h: 600 })
  assert.equal(manualEvents, 2)
  zoomToFit(store, { w: 800, h: 600 })
  assert.equal(manualEvents, 3)
})

test('явный автофокус результата не считается ручным движением камеры', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [{
      id: 'result',
      kind: 'image',
      x: 900,
      y: 600,
      w: 320,
      h: 240,
      src: '/media/result.png',
      sourceJobId: 'job-result',
    }],
  })
  let manualEvents = 0
  store.subscribeManualCamera(() => manualEvents++)

  store.focusGenerationResults(['job-result'])

  assert.equal(manualEvents, 0)
  assert.equal(store.getManualCameraVersion(), 0)
})

function sourceFile(relativeUrl: string): ts.SourceFile {
  const filename = fileURLToPath(new URL(relativeUrl, import.meta.url))
  return ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function functionBody(source: ts.SourceFile, name: string): string {
  let body = ''
  const visit = (node: ts.Node): void => {
    if (
      ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(source) === name)
      && node.body
    ) {
      body = node.body.getText(source)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(body, `не найдено тело ${name}`)
  return body
}

function jsxHandlerBody(source: ts.SourceFile, name: string): string {
  let body = ''
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === name && ts.isJsxExpression(node.initializer)) {
      const expression = node.initializer.expression
      if ((ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) && expression.body) {
        body = expression.body.getText(source)
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(body, `не найден JSX-обработчик ${name}`)
  return body
}

test('wheel и Stage drag сигналят ручное управление, а автофокус результатов — нет', () => {
  const canvasSource = sourceFile('./KonvaCanvas.tsx')
  const storeSource = sourceFile('./canvasStore.ts')

  assert.match(functionBody(canvasSource, 'onWheel'), /store\.noteManualCameraInteraction\(\)/)
  assert.match(functionBody(canvasSource, 'onStageMouseDown'), /store\.noteManualCameraInteraction\(\)/)
  assert.match(jsxHandlerBody(canvasSource, 'onDragStart'), /store\.noteManualCameraInteraction\(\)/)
  assert.doesNotMatch(functionBody(storeSource, 'focusGenerationResults'), /noteManualCameraInteraction/)
})
