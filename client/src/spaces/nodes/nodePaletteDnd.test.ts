import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginNodePaletteDrag,
  nodeKindFromDrop,
  nodePositionFromDrop,
} from './nodePaletteDnd.js'

test('палитра пишет тип ноды в собственный DataTransfer-контракт', () => {
  const values = new Map<string, string>()
  const transfer = {
    effectAllowed: 'none',
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '',
  }

  beginNodePaletteDrag(transfer, 'video')

  assert.equal(transfer.effectAllowed, 'copy')
  assert.equal(nodeKindFromDrop(transfer), 'video')
  values.set('application/x-canai-node-kind', 'unknown')
  assert.equal(nodeKindFromDrop(transfer), null)
})
test('drop центрирует новую ноду в точной flow-координате указателя', () => {
  assert.deepEqual(
    nodePositionFromDrop(
      { clientX: 460, clientY: 260 },
      ({ x, y }) => ({ x: x / 2 + 10, y: y / 2 - 5 }),
      { width: 280, height: 150 },
    ),
    { x: 100, y: 50 },
  )
})
