import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptChatTransport } from './promptChatTransport.js'

test('prompt chat transport различает local/cloud даже при одинаковом id', async () => {
  const calls: string[] = []
  const adapter = (name: string) => new Proxy({}, {
    get: (_target, method: string) => async (projectId: string) => {
      calls.push(`${name}:${method}:${projectId}`)
      return { index: { version: 2, revision: 0, activeConversationId: null, conversations: [], hasTrash: false } }
    },
  })
  const transport = createPromptChatTransport(adapter('local') as never, adapter('cloud') as never)
  await transport.listPromptChats('local:same')
  await transport.listPromptChats('cloud:same')
  await transport.listPromptChats('legacy-id')
  assert.deepEqual(calls, [
    'local:listPromptChats:same',
    'cloud:listPromptChats:same',
    'local:listPromptChats:legacy-id',
  ])
})

test('cloud transport можно заменить после создания store для прямого tablet-сеанса', async () => {
  const calls: string[] = []
  const adapter = (name: string) => new Proxy({}, {
    get: () => async (projectId: string) => {
      calls.push(`${name}:${projectId}`)
      return { index: { version: 2, revision: 0, activeConversationId: null, conversations: [], hasTrash: false } }
    },
  })
  let cloud = adapter('desktop') as never
  const transport = createPromptChatTransport(adapter('local') as never, () => cloud)
  await transport.listPromptChats('cloud:same')
  cloud = adapter('tablet') as never
  await transport.listPromptChats('cloud:same')
  assert.deepEqual(calls, ['desktop:same', 'tablet:same'])
})
