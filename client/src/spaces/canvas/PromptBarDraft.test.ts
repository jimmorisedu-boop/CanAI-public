import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createPromptChatStore, type PromptChatStoreDeps } from './promptChatStore'
import { draftFromComposer } from './promptChatComposer'
import { pendingDiscussDraftToRestore } from './promptChatDraftRestore'
import { projectKey } from '../../projects/projectRef'

// Исполняем настоящий обработчик компонента с настоящим store. Подменён только
// транспорт: прежний сырой id должен снова сломать сохранение видимого диалога.
const sourceText = readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('PromptBar.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const handlers: ts.FunctionDeclaration[] = []
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'persistChatDraft') handlers.push(node)
  ts.forEachChild(node, visit)
}
visit(source)
assert.equal(handlers.length, 1)
const handlerJs = ts.transpileModule(handlers[0].getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

test('PromptBar draft persistence stays outside functional state updaters', () => {
  let nestedPersistenceCalls = 0
  function visitUpdater(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const setter = node.expression.getText(source)
      const callback = node.arguments[0]
      if ((setter === 'setPrompt' || setter === 'setManualRefs')
        && callback
        && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        function visitCallback(child: ts.Node): void {
          if (ts.isCallExpression(child) && child.expression.getText(source) === 'persistChatDraft') {
            nestedPersistenceCalls += 1
          }
          ts.forEachChild(child, visitCallback)
        }
        ts.forEachChild(callback, visitCallback)
      }
    }
    ts.forEachChild(node, visitUpdater)
  }
  visitUpdater(source)
  assert.equal(nestedPersistenceCalls, 0)
})

function fixture() {
  const rawId = 'draft-project'
  const key = projectKey({ source: 'local', id: rawId })
  const pages = new Map(['c1', 'c2'].map(id => [id, {
    meta: {
      version: 2, revision: 0, id, projectId: rawId, title: id,
      selectedModelId: 'qwen', createdAt: 1, updatedAt: 1, activeJobIds: [],
      draft: { text: '', attachments: [], selectionStart: 0, selectionEnd: 0 },
    },
    messages: [], before: null, contextHealth: 'ready',
  }]))
  let activeId = 'c1'
  let sequence = 0
  let error: string | null = null
  const pendingDiscussDraftRef: { current: ReturnType<typeof draftFromComposer> | null } = { current: null }
  const patches: string[] = []
  const deps = new Proxy({
    id: () => `request-${++sequence}`,
    listPromptChats: async () => ({ index: {
      version: 2, revision: 1, activeConversationId: activeId, hasTrash: false,
      conversations: [...pages.keys()].map(id => ({ id, title: id, createdAt: 1, updatedAt: 1, preview: '', attention: 'idle' })),
    } }),
    listPromptChatTrash: async () => ({ conversations: [] }),
    loadPromptChatPage: async (_project: string, id: string) => structuredClone(pages.get(id)),
    activatePromptChat: async (_project: string, id: string) => {
      activeId = id
      return { meta: structuredClone(pages.get(id)!.meta) }
    },
    patchPromptChat: async (project: string, id: string, _requestId: string, patch: object) => {
      assert.equal(project, key, 'transport must receive the subscribed local key')
      patches.push(id)
      const page = pages.get(id)!
      page.meta = { ...page.meta, ...structuredClone(patch), revision: page.meta.revision + 1 }
      return { meta: structuredClone(page.meta) }
    },
    registerSink: () => () => {},
    schedule: () => ++sequence,
    unschedule: () => {},
  }, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property)
      return () => { throw new Error(`Unexpected dependency: ${String(property)}`) }
    },
  }) as unknown as PromptChatStoreDeps
  const store = createPromptChatStore(deps)
  const handler = (discussOpen = true) => new Function(
    'discussOpen', 'promptChatSnapshot', 'promptChatStore', 'projectId', 'promptChatProjectId',
    'draftFromComposer', 'pendingDiscussDraftRef', 'setLocalError', `${handlerJs}\nreturn persistChatDraft;`,
  )(discussOpen, store.getSnapshot(key), store, rawId, key, draftFromComposer, pendingDiscussDraftRef,
    (message: string) => { error = message })
  return { key, deps, store, handler, patches, pendingDiscussDraftRef, get error() { return error } }
}

test('local composer text, references and caret survive conversation switching and reload', async () => {
    const f = fixture()
    await f.store.loadProject(f.key)
    assert.equal(f.store.getSnapshot(f.key).loadState, 'ready')
    assert.equal(f.store.getSnapshot(f.key).activeId, 'c1')
    f.handler()('Вопрос с референсом', [{ shapeId: 'image-1', kind: 'image', src: '/media/ref.png' }], 2, 7)
    await Promise.resolve()
    await f.store.flush(f.key)
    assert.equal(f.error, null)
    assert.deepEqual(f.patches, ['c1'])
    await f.store.selectConversation(f.key, 'c2')
    await f.store.selectConversation(f.key, 'c1')
    const restored = createPromptChatStore(f.deps)
    await restored.loadProject(f.key)
    const draft = restored.getSnapshot(f.key).active!.meta.draft
    assert.equal(draft.text, 'Вопрос с референсом')
    assert.equal(draft.attachments.length, 1)
    assert.equal(draft.attachments[0].src, '/media/ref.png')
    assert.equal(draft.selectionStart, 2)
    assert.equal(draft.selectionEnd, 7)
    assert.equal(restored.getSnapshot(f.key).active!.meta.selectedModelId, 'qwen')
})

test('typing before load or in the ordinary prompt does not write a conversation draft', async () => {
  const f = fixture()
  f.handler()('До загрузки', [])
  await f.store.loadProject(f.key)
  f.handler(false)('Обычный промпт', [])
  await Promise.resolve()
  await f.store.flush(f.key)
  assert.equal(f.error, null)
  assert.deepEqual(f.patches, [])
})

test('first Discuss load restores a draft queued before the new conversation existed', () => {
  const pending = draftFromComposer(
    'Сделай обложку',
    [{ shapeId: 'image-1', kind: 'image', label: 'референс', src: '/media/ref.png' }],
    7,
    7,
  )
  const restored = pendingDiscussDraftToRestore({
    pending,
    wasOpen: true,
    previousConversationId: null,
    activeConversationId: 'conversation-1',
  })
  assert.deepEqual(restored, pending)
  assert.notEqual(restored, pending)
  assert.equal(pendingDiscussDraftToRestore({
    pending,
    wasOpen: false,
    previousConversationId: null,
    activeConversationId: 'conversation-1',
  }), null)
  assert.equal(pendingDiscussDraftToRestore({
    pending,
    wasOpen: true,
    previousConversationId: 'conversation-0',
    activeConversationId: 'conversation-1',
  }), null)
})
