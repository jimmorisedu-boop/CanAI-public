import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertGraphAcceptable,
  GraphTooLargeError,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
} from './graphLimits.js'

test('assertGraphAcceptable accepts a normal graph', () => {
  assert.doesNotThrow(() =>
    assertGraphAcceptable({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    }),
  )
})

test('assertGraphAcceptable rejects too many nodes', () => {
  const nodes = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => ({ id: String(i) }))
  assert.throws(
    () => assertGraphAcceptable({ nodes, edges: [] }),
      (err: unknown) => err instanceof GraphTooLargeError && /Too many nodes/.test((err as Error).message),
  )
})

test('assertGraphAcceptable rejects too many edges', () => {
  const edges = Array.from({ length: MAX_GRAPH_EDGES + 1 }, (_, i) => ({
    id: String(i),
    source: 'a',
    target: 'b',
  }))
  assert.throws(
    () => assertGraphAcceptable({ nodes: [{ id: 'a' }], edges }),
      (err: unknown) => err instanceof GraphTooLargeError && /Too many connections/.test((err as Error).message),
  )
})

test('assertGraphAcceptable rejects non-object', () => {
  assert.throws(() => assertGraphAcceptable(null), GraphTooLargeError)
  assert.throws(() => assertGraphAcceptable([]), GraphTooLargeError)
})

test('assertGraphAcceptable rejects graphs with non-array nodes or edges', () => {
  assert.throws(
    () => assertGraphAcceptable({ nodes: {}, edges: [] }),
    (err: unknown) =>
      err instanceof GraphTooLargeError && /Field nodes must be array/u.test(err.message),
  )
  assert.throws(
    () => assertGraphAcceptable({ nodes: [], edges: 'broken' }),
    (err: unknown) =>
      err instanceof GraphTooLargeError && /Field edges must be array/u.test(err.message),
  )
})
