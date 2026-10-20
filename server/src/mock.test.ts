import assert from 'node:assert/strict'
import test from 'node:test'
import { mockImage, mockText } from './mock.js'

test('mock image follows GPT Image 2 portrait size', () => {
  const image = mockImage('портрет', 0, 0, { image_size: 'portrait_16_9' })

  assert.deepEqual(
    { width: image.width, height: image.height },
    { width: 576, height: 1024 },
  )
  assert.match(image.buffer.toString('utf8'), /width="576" height="1024"/)
})

test('mock image follows canonical numeric aspect ratio', () => {
  const image = mockImage('альбом', 0, 0, { aspect_ratio: '16:9' })

  assert.deepEqual(
    { width: image.width, height: image.height },
    { width: 1024, height: 576 },
  )
})

test('mock assistant returns useful prompt-chat JSON without echoing internal instructions', () => {
  const text = mockText('Ответь строго JSON-объектом.\nИстория диалога:\nПользователь [message-1]: постер для кофейни')
  const parsed = JSON.parse(text) as { reply: string; prompts: Array<{ prompt: string }> }
  assert.ok(parsed.reply)
  assert.ok(parsed.prompts.length > 0)
  assert.match(parsed.prompts[0].prompt, /постер для кофейни/)
  assert.doesNotMatch(text, /Ответь строго JSON/)
})
