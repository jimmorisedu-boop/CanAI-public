// @ts-nocheck — Node test globals are executed by tsx and are outside the browser tsconfig.
import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore'

interface SketchHistoryStore {
  undoStroke(): boolean
  redoStroke(): boolean
  canUndoStroke(): boolean
  canRedoStroke(): boolean
}

test('sketch strokes have an independent undo and redo history', () => {
  const store = new CanvasStore()
  const history = store as unknown as SketchHistoryStore

  store.startStroke('#e0554e', 6, 10, 10)
  store.extendStroke(20, 20)
  store.startStroke('#1a1a1f', 8, 30, 30)

  assert.equal(store.getStrokes().length, 2)
  assert.equal(history.canUndoStroke(), true)
  assert.equal(history.canRedoStroke(), false)

  assert.equal(history.undoStroke(), true)
  assert.equal(store.getStrokes().length, 1)
  assert.equal(history.canRedoStroke(), true)

  assert.equal(history.redoStroke(), true)
  assert.equal(store.getStrokes().length, 2)
})

test('a new stroke after undo clears only the sketch redo branch', () => {
  const store = new CanvasStore()
  const history = store as unknown as SketchHistoryStore

  store.startStroke('#e0554e', 6, 0, 0)
  store.startStroke('#1a1a1f', 6, 5, 5)
  history.undoStroke()
  store.startStroke('#2f8f6f', 6, 8, 8)

  assert.equal(history.canRedoStroke(), false)
  assert.equal(store.getStrokes().length, 2)
})
