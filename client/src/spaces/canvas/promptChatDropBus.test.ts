import assert from 'node:assert/strict'
import test from 'node:test'
import {
  notifyPromptChatDropHover,
  registerPromptChatDropHandler,
  requestPromptChatDrop,
} from './promptChatDropBus'

const event = {
  kind: 'reference' as const,
  ref: {
    shapeId: 'image-1',
    kind: 'image' as const,
    label: 'Кадр',
    src: '/media/frame.png',
  },
}

test('drop доставляется только текущему обработчику, устаревшая отписка безопасна', () => {
  const calls: string[] = []
  const unregisterFirst = registerPromptChatDropHandler({
    drop: () => calls.push('first-drop'),
    hover: (active) => calls.push(`first-hover:${active}`),
  })
  registerPromptChatDropHandler({
    drop: () => calls.push('second-drop'),
    hover: (active) => calls.push(`second-hover:${active}`),
  })

  unregisterFirst()
  notifyPromptChatDropHover(true)
  assert.equal(requestPromptChatDrop(event), true)
  assert.deepEqual(calls, ['second-hover:true', 'second-drop'])

  registerPromptChatDropHandler(null)
  assert.equal(requestPromptChatDrop(event), false)
})

test('a group is delivered in one event with independent reference snapshots', () => {
  const refs = [event.ref, { ...event.ref, shapeId: 'image-2' }]
  const unregister = registerPromptChatDropHandler({
    hover() {},
    drop: (received) => {
      assert.equal(received.kind, 'references')
      if (received.kind !== 'references') return
      assert.deepEqual(received.refs.map((ref) => ref.shapeId), ['image-1', 'image-2'])
      received.refs[0].label = 'changed'
      received.refs.pop()
    },
  })
  try {
    assert.equal(requestPromptChatDrop({ kind: 'references', refs }), true)
    assert.equal(refs.length, 2)
    assert.equal(refs[0].label, 'Кадр')
  } finally { unregister() }
})
