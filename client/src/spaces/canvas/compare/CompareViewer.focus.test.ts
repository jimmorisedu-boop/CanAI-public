// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { CanvasStore } from '../konva/canvasStore'
import { compareLayout, visibleSlice, wrapCursor } from './compareLayout'
import { panelLabel, panelSubLabel } from './compareLabels'
import { isMarkDigit } from '../konva/markInput'
import { faceBoxFraction } from './faceMath'
import { handleCompareFrameKey } from './compareFrameStep'

// Execute production component and focus manager hooks. Only React lifecycle,
// DOM layout and media rendering are simulated; no API or face model is loaded.
class Element {
  children: Element[] = []
  parentElement: Element | null = null
  inert = false
  hidden = false
  disabled = false
  tabIndex: number
  attrs = new Map<string, string>()
  constructor(readonly ownerDocument: Doc, readonly tagName = 'DIV', modal = false) {
    this.tabIndex = ['BUTTON','INPUT','SELECT','TEXTAREA'].includes(tagName) ? 0 : -1
    if (modal) this.attrs.set('aria-modal', 'true')
  }
  get isConnected(): boolean { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected) }
  append(child: Element) { this.children.push(child); child.parentElement = this }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  getAttribute(name: string) { return this.attrs.get(name) ?? null }
  hasAttribute(name: string) { return this.attrs.has(name) }
  closest(selector: string): Element | null {
    if ((selector.includes('inert') && this.inert) || (selector.includes('hidden') && this.hidden)) return this
    if (selector.includes('.compare-overlay button') && this.tagName === 'BUTTON') return this
    return this.parentElement?.closest(selector) ?? null
  }
  getClientRects() { return this.isConnected && !this.hidden ? [{}] : [] }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...((selector.includes('aria-modal') ? child.getAttribute('aria-modal') === 'true' : child.tabIndex >= 0 && !child.disabled) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
  focus() { this.ownerDocument.activeElement = this; this.ownerDocument.emit('focusin', { target: this }) }
}
class Doc {
  body = new Element(this, 'BODY')
  activeElement: Element = this.body
  listeners = new Map<string, Set<(event: any) => void>>()
  windowListeners = new Map<string, Set<(event: any) => void>>()
  observers: Array<() => void> = []
  defaultView = { MutationObserver: class {
    constructor(callback: () => void) { docForObserver.observers.push(callback) }
    observe() {}
    disconnect() {}
  } }
  addEventListener(type: string, listener: any) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener) }
  removeEventListener(type: string, listener: any) { this.listeners.get(type)?.delete(listener) }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector) }
  emit(type: string, event: any) { for (const listener of this.listeners.get(type) ?? []) { if(event.stopped) break; listener(event) } }
  mutate() { for (const observer of this.observers) observer() }
  key(key: string, shiftKey = false) {
    const event = { key, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, stopImmediatePropagation() {} }
    this.emit('keydown', event)
    return event
  }
}
let docForObserver: Doc

class Hooks {
  slots = []; cursor = 0; effects = []
  begin() { this.cursor = 0; this.effects = [] }
  ref(value) { const i = this.cursor++; return this.slots[i] ??= { current:value } }
  state(value) { const slot = this.ref(typeof value === 'function' ? value() : value); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value }] }
}
function fixture(kind = 'video', empty = false, candidateIds = ['candidate']) {
  const document = new Doc(); docForObserver = document
  const window = {
    addEventListener(type, listener) { if (!document.windowListeners.has(type)) document.windowListeners.set(type,new Set()); document.windowListeners.get(type).add(listener) },
    removeEventListener(type, listener) { document.windowListeners.get(type)?.delete(listener) },
    setTimeout() { return 1 }, clearTimeout() {},
  }
  const background = new Element(document)
  const opener = new Element(document,'BUTTON'); background.append(opener); document.body.append(background); opener.focus()
  let hooks = new Hooks(), closeCalls = 0
  const react = {useRef:value => hooks.ref(value),useState:value => hooks.state(value),useMemo:fn => fn(),useEffect:fn => hooks.effects.push(fn),useLayoutEffect:fn => hooks.effects.push(fn)}
  const jsx = (type, props) => ({type, props})
  const stub = new Proxy({}, {get:(_,key) => key === '__esModule' ? true : () => null})
  function load(file, mocks={}) {
    const source = fs.readFileSync(new URL('../../../../../'+file,import.meta.url),'utf8')
    const code = ts.transpileModule(source,{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    const exports = {}
    vm.runInNewContext(code,{exports,require:name => name === 'react' ? react : name === 'react/jsx-runtime' ? {jsx,jsxs:jsx} : mocks[name] ?? stub,document,window,HTMLElement:Element,queueMicrotask}, {filename:file})
    return exports
  }
  const focus = load('client/src/tablet/modalFocus.ts')
  const mocks = {
    '../../../tablet/modalFocus':focus,
    '../konva/useStore':{useContentVersion:()=>0},
    '../konva/markInput':{isMarkDigit},
    './compareBus':{closeCompare:()=>closeCalls++},
    './compareLayout':{compareLayout,visibleSlice,wrapCursor},
    './compareLabels':{panelLabel,panelSubLabel},
    './FaceSimilarityChip':{useFaceSimilarity:()=>({kind:'off'})},
    './faceMath':{DEFAULT_FACE_THRESHOLD:0.5,faceBoxFraction},
  }
  const viewer = load('client/src/spaces/canvas/compare/CompareViewer.tsx',mocks)
  const facePicker = load('client/src/spaces/canvas/compare/FacePickOverlay.tsx',mocks)
  function commit(tree,parent) {
    if (!tree || typeof tree !== 'object') return null
    if (Array.isArray(tree)) { tree.forEach(child=>commit(child,parent)); return null }
    if (typeof tree.type !== 'string') return null
    const node = new Element(document,tree.type.toUpperCase())
    node.props = tree.props
    for (const [key,value] of Object.entries(tree.props)) if (key.startsWith('aria-') || key === 'role') node.attrs.set(key,String(value))
    node.tabIndex=tree.props.tabIndex ?? node.tabIndex
    node.hidden=Boolean(tree.props.hidden);node.disabled=Boolean(tree.props.disabled)
    parent.append(node)
    if (tree.props.ref) tree.props.ref.current=node
    for(const child of [tree.props.children].flat(Infinity)) commit(child,node)
    return node
  }
  function mountEffects() {
    const disposers=[]
    for(const effect of hooks.effects) {
      if(effect.toString().includes('api_1.api.')) continue
      const dispose=effect();if(typeof dispose==='function') disposers.push(dispose)
    }
    return ()=>disposers.forEach(dispose=>dispose())
  }
  const store=new CanvasStore()
  store.loadDoc({version:1,camera:{x:0,y:0,scale:1},items:empty?[]:[
    {id:'source',kind,x:0,y:0,w:320,h:240,name:'Source',src:'/media/source.mp4'},
    ...candidateIds.map((id,index)=>({id,kind,x:340+index*340,y:0,w:320,h:240,name:'Candidate'+(index+1),src:'/media/'+id+'.mp4'})),
  ]})
  const session={phase:'viewing',baselineId:'source',candidateIds}
  let modal,unmount
  // One React re-render: old effects are torn down, hook state survives.
  function render() {
    unmount?.();modal?.remove()
    hooks.begin()
    modal=commit(viewer.CompareViewer({store,session}),document.body)
    unmount=mountEffects()
    return modal
  }
  render()
  // Texts of every element carrying `className`, in document order.
  function textsOf(node,className) {
    const own = node.props?.className===className
      ? [[node.props.children].flat(Infinity).filter(child=>typeof child==='string').join('')] : []
    return [...own, ...node.children.flatMap(child=>textsOf(child,className))]
  }
  function key(key,shiftKey=false,extra={}) {
    const event={key,code:key,target:document.activeElement,shiftKey,defaultPrevented:false,stopped:false,
      preventDefault(){this.defaultPrevented=true},stopPropagation(){this.stopped=true},stopImmediatePropagation(){this.stopped=true},...extra}
    for(const fn of document.windowListeners.get('keydown')??[]) {if(event.stopped)break;fn(event)}
    if(!event.stopped) document.emit('keydown',event)
    return event
  }
  return {document,background,opener,store,key,render,closeCalls:()=>closeCalls,
    get modal(){return modal},
    // Who the header calls the candidate right now — the second role name.
    shownCandidate(){return textsOf(modal,'compare-role-name')[1] ?? null},
    close(){unmount?.();modal?.remove()},
    mountFace(onCancel) {
      const origin=document.activeElement
      hooks=new Hooks();hooks.begin()
      const tree=facePicker.FacePickOverlay({src:'/media/faces.webp',faces:[{x:0,y:0,w:10,h:10}],natural:{width:100,height:100},selected:0,title:'Source',onPick:()=>{},onCancel})
      const nested=commit(tree,modal.children[0]);const dispose=mountEffects();document.mutate()
      return {nested,origin,close(){dispose();nested.remove();document.mutate()}}
    },
  }
}
for(const [kind,empty] of [['video',false],['image',false],['image',true]]) {
  test('compare '+kind+(empty?' empty':'')+' autofocus, Tab wrap, inert and return focus',async()=>{
    const f=fixture(kind,empty)
    try {
      assert.ok(f.modal.contains(f.document.activeElement),'opening comparison must move focus inside')
      assert.equal(f.modal.getAttribute('aria-modal'),'true')
      assert.equal(f.background.inert,true)
      const nodes=f.modal.querySelectorAll('button, [tabindex]').filter(node=>node.tabIndex>=0)
      const first=nodes[0],last=nodes.at(-1)
      last.focus();assert.equal(f.key('Tab').defaultPrevented,true);assert.equal(f.document.activeElement,first)
      assert.equal(f.key('Tab',true).defaultPrevented,true);assert.equal(f.document.activeElement,last)
      f.opener.focus();assert.ok(f.modal.contains(f.document.activeElement),'background cannot claim focus')
      assert.equal(f.key('Escape').defaultPrevented,true);assert.equal(f.closeCalls(),1)
    }finally{f.close()}
    await Promise.resolve()
    assert.equal(f.document.activeElement,f.opener)
    assert.equal(f.background.inert,false)
  })
}
test('nested face picker owns Tab/Escape and returns to its comparison control',async()=>{
  const f=fixture('image')
  let dismissed=0
  const control=f.modal.querySelectorAll('button').at(-1);control.focus()
  const face=f.mountFace(()=>dismissed++)
  try {
    assert.ok(face.nested.contains(f.document.activeElement),'nested dialog receives focus')
    const first=face.nested.querySelectorAll('button')[0],last=face.nested.querySelectorAll('button').at(-1)
    last.focus();assert.equal(f.key('Tab').defaultPrevented,true);assert.equal(f.document.activeElement,first)
    assert.equal(f.key('Tab',true).defaultPrevented,true);assert.equal(f.document.activeElement,last)
    f.key('Delete');assert.equal(f.store.getItems().length,2,'nested dialog must not archive candidate')
    f.key('Escape');assert.equal(dismissed,1);assert.equal(f.closeCalls(),0,'only face picker closes')
  }finally{face.close()}
  assert.equal(f.document.activeElement,control)
  f.key('Escape');assert.equal(f.closeCalls(),1)
  f.close();await Promise.resolve();assert.equal(f.document.activeElement,f.opener)
})
test('focus capture leaves physical A/D and Shift+A/D to the video player',()=>{
  const f=fixture('video')
  const stepped=[]
  try {
    for(const [code,shiftKey,expected]of[['KeyD',false,1],['KeyA',false,-1],['KeyD',true,10],['KeyA',true,-10]]) {
      const event=f.key(code==='KeyD'?'d':'a',shiftKey,{code})
      assert.equal(handleCompareFrameKey(event,frames=>{stepped.push(frames);return true}),true)
      assert.equal(stepped.at(-1),expected)
    }
  }finally{f.close()}
})
// Delete archives the candidate and MUST NOT reach the canvas hotkeys underneath.
// archiveCurrent closes the comparison when the candidate was the last one, so by
// the time the event bubbles further `getCompareSession()` is already empty and the
// canvas guard no longer protects anything: the very same Delete used to run
// removeSelected and wipe the BASELINE off the board, silently, past the archive.
test('Delete stays inside the comparison and never reaches the canvas hotkeys', () => {
  const f = fixture('image')
  let canvasHotkeys = 0
  // Stands in for useCanvasHotkeys: same window keydown, one bubbling stage later.
  f.document.addEventListener('keydown', event => { if (event.key === 'Delete') { canvasHotkeys++; f.store.removeItems(['source']) } })
  try {
    f.key('Delete')
    assert.equal(canvasHotkeys, 0, 'canvas hotkeys must not see Delete while comparing')
    assert.deepEqual(f.store.getItems().map(item => item.id), ['source'], 'baseline stays on the board')
    assert.deepEqual(f.store.getArchive().map(item => item.id), ['candidate'], 'candidate goes to the archive')
    assert.equal(f.closeCalls(), 1, 'last candidate archived closes the comparison')
  } finally { f.close() }
})
// Delete sends the loser to the archive, so the viewer must move on to the next
// candidate. It used to keep showing the archived one: candidates were resolved
// in the archive as well (that fallback belongs to the baseline, which may be
// pulled in by pedigree), so the list never got shorter — the next Delete found
// nothing left to archive and the loser stayed on screen for good.
test('archiving one of two candidates moves on to the next one', () => {
  const f = fixture('image', false, ['candidate', 'rival'])
  try {
    const first = f.shownCandidate()
    f.key('Delete'); f.render()
    assert.deepEqual(f.store.getArchive().map(item => item.id), ['candidate'])
    assert.notEqual(f.shownCandidate(), first, 'the archived candidate must leave the screen')
    assert.equal(f.closeCalls(), 0, 'one candidate left — the comparison goes on')
    f.key('Delete'); f.render()
    assert.deepEqual(f.store.getArchive().map(item => item.id).sort(), ['candidate', 'rival'])
    assert.deepEqual(f.store.getItems().map(item => item.id), ['source'], 'baseline stays on the board')
    assert.equal(f.closeCalls(), 1, 'the last candidate archived closes the comparison')
  } finally { f.close() }
})
