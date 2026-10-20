// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const requireClient = createRequire(path.join(root, 'client/package.json'))
const ts = requireClient('typescript')

const source = (file) => fs.readFileSync(path.join(root, file), 'utf8')
let runner
class Hooks {
  slots = []; cursor = 0; effects = []
  begin() { this.cursor = 0; this.effects = [] }
  state(initial) {
    const i = this.cursor++
    if (!(i in this.slots)) this.slots[i] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = this.slots[i]
    slot.set ??= (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }
    return [slot.value, slot.set]
  }
  ref(value) { const i = this.cursor++; return this.slots[i] ??= { current: value } }
}
const react = {
  useState: (initial) => runner.state(initial), useRef: (value) => runner.ref(value),
  useEffect: (callback) => runner.effects.push(callback), useLayoutEffect: () => {},
  useMemo: (fn) => fn(), useCallback: (fn) => fn,
}
class Element {
  listeners = new Map(); nodeType = 1; isContentEditable = false; parent = null; children = []; attributes = {}
  constructor(tagName = 'DIV') { this.tagName = tagName; this.nodeName = tagName }
  addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list) }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== fn)) }
  append(child) { child.parent = this; this.children.push(child); return child }
  focus() { document.activeElement = this }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector) {
    const matches = child => selector.split(',').some(part => {
      const role = part.match(/\[role="([^"]+)"\]/)?.[1]
      if (role && child.attributes.role !== role) return false
      return part.includes('aria-modal')
        ? child.attributes['aria-modal'] === 'true'
        : ['BUTTON','INPUT','SELECT','TEXTAREA'].includes(child.tagName)
    })
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null }

  getAttribute(name) { return this.attributes[name] ?? null }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name) }
  closest(selector) { return selector.includes('aria-modal') && this.parent?.attributes['aria-modal'] === 'true' ? this.parent : null }
  dispatch(event) {
    event.target ??= this
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event)
    if (!event.stopped) this.parent?.dispatch(event)
  }
}
const window = new Element('WINDOW')
window.setTimeout = (fn) => { fn(); return 1 }
window.clearTimeout = () => {}
const document = new Element('DOCUMENT'); document.parent = window
document.activeElement = null
const globals = { window, document, HTMLElement: Element, console, setTimeout, clearTimeout }
const stubModule = new Proxy({}, { get: (_, key) => key === '__esModule' ? true : () => null })
function moduleFrom(file, mocks, appended = '') {
  const code = ts.transpileModule(source(file) + appended, {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [(ctx) => (node) => {
      const visit = (item) => ts.isMetaProperty(item) && item.keywordToken === ts.SyntaxKind.ImportKeyword
        ? ts.factory.createIdentifier('__importMeta') : ts.visitEachChild(item, visit, ctx)
      return ts.visitNode(node, visit)
    }] },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, { ...globals, __importMeta: { env: { DEV: false } }, exports,
    require: (name) => name === 'react' ? react : mocks[name] ?? stubModule,
  }, { filename: file })
  return exports
}

let nextId = 0
const graphHooks = new Hooks()
const graphModule = moduleFrom('client/src/spaces/nodes/useNodesGraph.ts', {
  '@xyflow/react': {
    useNodesState: (initial) => [...react.useState(initial), () => {}],
    useEdgesState: (initial) => [...react.useState(initial), () => {}],
  },
  './macroSaveCoordinator': { MacroLoadGuard: class {}, createMacroSaveCoordinator: () => ({}), canClearMacroSlot: () => false },
  '../../ui/ids': { newId: () => `fixture-clone-${++nextId}` },
})
let graph
function renderGraph() {
  runner = graphHooks; runner.begin(); graph = graphModule.useNodesGraph(0, null)
  return graph
}
renderGraph()
// Seed only hook state (an already-loaded, unsaved in-memory graph). Never run loading/saving effects.
graphHooks.slots[0].value = [{ id: 'fixture-node', type: 'gen', position: { x: 0, y: 0 }, selected: true,
  data: { kind: 'input', prompt: '', status: 'idle' } }]
graphHooks.slots[2].value = true
graphHooks.slots[3].value = false
renderGraph()
function recordHistory() {
  const history = graphHooks.effects.find(fn => fn.toString().includes('undoStack.current.push'))
  assert.ok(history, 'production history effect was found'); history()
}
recordHistory()

const deleted = []
const rf = { screenToFlowPosition: p => p, deleteElements: async value => {
  deleted.push({ nodes: value.nodes.map(n => n.id), edges: value.edges.map(e => e.id) })
  graph.setNodes(graph.nodes.filter(n => !value.nodes.some(selected => selected.id === n.id)))
  graph.setEdges(graph.edges.filter(e => !value.edges.some(selected => selected.id === e.id)))
} }
let tree
const flowHooks = new Hooks()
const flowModule = moduleFrom('client/src/spaces/nodes/NodesSpace.tsx', {
  './useNodesGraph': { useNodesGraph: () => graph },
  '@xyflow/react': { useReactFlow: () => rf, ReactFlow: 'RF' },
  'react/jsx-runtime': { jsx: (type, props) => ({type, props}), jsxs: (type, props) => ({type, props}) },
  './graphDiagnostics': { validateGraph: () => [], summarizeDiagnostics: () => ({}) },
  './modelsContext': { useModels: () => [] },
  '../../ui/hotkeys': { hits: () => false },
  '../../ui/useCompactLayout': { useCompactLayout: () => false },
  '../../settings/navigationMode': { useNavigationMode: () => 'mouse', reactFlowNavigationProps: () => ({}) },
}, '\nexport { Flow as AuditFlow };\n')
function renderFlow() {
  runner = flowHooks; runner.begin()
  tree = flowModule.AuditFlow({ slot: 0, macroId: null, theme: 'light', registerLeaveGuard: () => () => {}, onClose: async () => true })
}
renderFlow()
const keyboardEffect = flowHooks.effects.find(fn => fn.toString().includes("addEventListener('keydown'"))
assert.ok(keyboardEffect, 'production Flow keyboard effect was captured')
const disposeFlow = keyboardEffect()


function findFlow(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'RF') return node.props
  for (const child of [node.props?.children].flat(Infinity)) { const result = findFlow(child); if (result) return result }
  return null
}
function key(target, key, extra = {}) {
  const event = { type: 'keydown', target, key, code: key === ' ' ? 'Space' : key.length === 1 ? 'Key'+key.toUpperCase() : key,
    ctrlKey: key.length === 1, metaKey: false, shiftKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...extra }
  target.dispatch(event)
  renderGraph(); renderFlow()
  return event
}
const background = document.append(new Element('DIV'))
const button = background.append(new Element('BUTTON'))
const select = background.append(new Element('SELECT'))
const input = background.append(new Element('INPUT'))
const textarea = background.append(new Element('TEXTAREA'))
const editable = background.append(new Element('DIV')); editable.isContentEditable = true

test('SELECT and input controls retain all graph shortcuts', () => {
  for (const target of [input, textarea, select, editable]) {
    for (const pressed of ['d', 'z', 'a', 'c', 'v', 'y', ' ', 'Delete', 'Backspace']) {
      const before = JSON.stringify(graph.nodes)
      const event = key(target, pressed)
      assert.equal(JSON.stringify(graph.nodes), before, target.tagName+' '+pressed+' changed graph')
      assert.equal(event.defaultPrevented, false)
    }
  }
})

test('modal blocks graph edits even with focus still on background', () => {
  const dialog = document.append(new Element('DIV')); dialog.attributes = {role:'dialog','aria-modal':'true'}
  const close = dialog.append(new Element('BUTTON'))
  try {
    for (const target of [close, button]) {
      for (const pressed of ['d', 'z', 'a', 'c', 'v', 'y', ' ', 'Delete', 'Backspace']) {
        const before = JSON.stringify(graph.nodes)
        key(target, pressed)
        assert.equal(JSON.stringify(graph.nodes), before, pressed+' changed graph behind dialog')
      }
    }
  } finally { dialog.remove() }
})

test('actual ConfirmHost alertdialog blocks graph shortcuts and deletion', () => {
  const confirmModule = moduleFrom('client/src/ui/ConfirmHost.tsx', {
    'react-dom': { createPortal: child => child },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  })
  const confirmHooks = new Hooks()
  runner = confirmHooks; runner.begin(); confirmModule.ConfirmHost()
  confirmHooks.slots[0].value = {
    request: { title: 'Удалить макрос?', confirmLabel: 'Удалить макрос', danger: true }, resolve() {},
  }
  runner = confirmHooks; runner.begin()
  const tree = confirmModule.ConfirmHost()
  const renderedDialog = tree.props.children
  assert.equal(renderedDialog.props.role, 'alertdialog')
  const dialog = document.append(new Element('DIV'))
  dialog.attributes = { role: renderedDialog.props.role, 'aria-modal': String(renderedDialog.props['aria-modal']) }
  const confirmButton = dialog.append(new Element('BUTTON'))
  try {
    for (const target of [confirmButton, button]) {
      for (const pressed of ['d', 'z', 'a', 'c', 'v', 'y', 'Delete', 'Backspace']) {
        const before = JSON.stringify(graph.nodes)
        const removedBefore = deleted.length
        key(target, pressed)
        assert.equal(JSON.stringify(graph.nodes), before, pressed + ' changed graph behind ConfirmHost')
        assert.equal(deleted.length, removedBefore, pressed + ' invoked deletion behind ConfirmHost')
      }
    }
  } finally { dialog.remove() }
})

test('defaultPrevented events do not edit nodes', () => {
  const before = JSON.stringify(graph.nodes)
  key(button, 'd', { defaultPrevented: true })
  assert.equal(JSON.stringify(graph.nodes), before)
})

test('shortcuts resume after modal closes: Russian duplicate/undo and Delete/undo', () => {
  // Reset fixture between contracts, using the real hook state.
  graph.setNodes([{id:'fixture-node',selected:true,type:'gen',position:{x:0,y:0},data:{kind:'input',status:'idle'}}])
  renderGraph(); renderFlow(); recordHistory()
  key(button, 'в')
  assert.equal(graph.nodes.length, 2)
  recordHistory()
  key(button, 'я')
  assert.equal(graph.nodes.length, 1)
  recordHistory()
  key(button, 'Delete', { ctrlKey: false })
  assert.equal(graph.nodes.length, 0)
  assert.equal(deleted.at(-1).nodes[0], 'fixture-node')
  recordHistory()
  key(button, 'z')
  assert.equal(graph.nodes.length, 1)
})

test('React Flow receives disabled native deletion; app owns the guarded command', () => {
  assert.equal(findFlow(tree).deleteKeyCode, null)
})

test('installed React Flow listener cannot delete through a modal with the actual Flow props', () => {
  function declarations(file, names) {
    const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    return names.map(name => {
      const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
      assert.ok(declaration, `installed ${name} exists`)
      return declaration.getText(ast)
    }).join('\n')
  }
  const code = declarations('client/node_modules/@xyflow/react/dist/esm/index.mjs', ['useKeyPress', 'isMatchingKey', 'useKeyOrCode', 'useGlobalKeyHandler'])
    + '\n' + declarations('client/node_modules/@xyflow/system/dist/esm/index.mjs', ['isInputDOMNode'])
  const nativeDeletes = []
  const native = vm.runInNewContext(code + '\nuseGlobalKeyHandler', {
    ...globals, ...react, inputTags: ['INPUT', 'SELECT', 'TEXTAREA'], defaultDoc: document, win$1: window,
    selected: item => item.selected,
    useStoreApi: () => ({ getState: () => ({ nodes: [{ id: 'native-fixture', selected: true }], edges: [] }), setState() {} }),
    useReactFlow: () => ({ deleteElements: value => nativeDeletes.push(value.nodes.map(node => node.id)) }),
  })
  const dialog = document.append(new Element('DIV')); dialog.attributes = { role: 'dialog', 'aria-modal': 'true' }
  const target = dialog.append(new Element('BUTTON'))
  try {
    for (const [deleteKeyCode, expected] of [[['Delete'], 1], [findFlow(tree).deleteKeyCode, 0]]) {
      const nativeHooks = new Hooks()
      const render = () => { runner = nativeHooks; runner.begin(); native({ deleteKeyCode, multiSelectionKeyCode: null }) }
      render()
      const cleanup = nativeHooks.effects.map(effect => effect()).filter(value => typeof value === 'function')
      nativeDeletes.length = 0
      key(target, 'Delete', { ctrlKey: false })
      render()
      nativeHooks.effects.find(effect => effect.toString().includes('deleteElements'))()
      assert.equal(nativeDeletes.length, expected)
      cleanup.forEach(dispose => dispose())
    }
  } finally { dialog.remove(); disposeFlow() }
})
