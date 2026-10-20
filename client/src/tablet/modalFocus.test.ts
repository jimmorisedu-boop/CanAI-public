import assert from 'node:assert/strict'
import test from 'node:test'
import { activateModalFocus } from './modalFocus.js'

// Small DOM event double: tests the production scope's focus, event and inert
// behavior. Browser layout / accessibility-tree verification is a separate gate.
class Element {
  children: Element[] = []
  parentElement: Element | null = null
  inert = false
  hidden = false
  disabled = false
  tabIndex: number
  attrs = new Map<string, string>()
  constructor(readonly ownerDocument: Doc, readonly tagName = 'DIV', modal = false) {
    this.tabIndex = tagName === 'BUTTON' ? 0 : -1
    if (modal) this.attrs.set('aria-modal', 'true')
  }
  get isConnected(): boolean { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected) }
  append(child: Element) { this.children.push(child); child.parentElement = this }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)) }
  getAttribute(name: string) { return this.attrs.get(name) ?? null }
  hasAttribute(name: string) { return this.attrs.has(name) }
  closest(selector: string): Element | null {
    if ((selector.includes('inert') && this.inert) || (selector.includes('hidden') && this.hidden)) return this
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
  observers: Array<() => void> = []
  defaultView = { MutationObserver: class {
    constructor(callback: () => void) { docForObserver.observers.push(callback) }
    observe() {}
    disconnect() {}
  } }
  addEventListener(type: string, listener: any) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener) }
  removeEventListener(type: string, listener: any) { this.listeners.get(type)?.delete(listener) }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector) }
  emit(type: string, event: any) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  mutate() { for (const observer of this.observers) observer() }
  key(key: string, shiftKey = false) {
    const event = { key, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, stopImmediatePropagation() {} }
    this.emit('keydown', event)
    return event
  }
}
let docForObserver: Doc
function fixture() {
  const doc = new Doc()
  docForObserver = doc
  const background = new Element(doc)
  const opener = new Element(doc, 'BUTTON')
  background.append(opener)
  doc.body.append(background)
  opener.focus()
  const modal = new Element(doc, 'DIV', true)
  const first = new Element(doc, 'BUTTON')
  const last = new Element(doc, 'BUTTON')
  modal.append(first); modal.append(last); doc.body.append(modal)
  return { doc, background, opener, modal, first, last }
}
const asHtml = (node: Element) => node as unknown as HTMLElement

test('modal owns entry, background inert, Tab wrap and restores its opener', async () => {
  const { doc, modal, background, opener, first, last } = fixture()
  const close = activateModalFocus(asHtml(modal))
  assert.equal(doc.activeElement, first)
  assert.equal(background.inert, true)
  last.focus(); assert.equal(doc.key('Tab').defaultPrevented, true); assert.equal(doc.activeElement, first)
  doc.key('Tab', true); assert.equal(doc.activeElement, last)
  opener.focus(); assert.ok(modal.contains(doc.activeElement))
  close(); modal.remove(); await Promise.resolve()
  assert.equal(background.inert, false)
  assert.equal(doc.activeElement, opener)
})

test('nested confirmation owns Escape, then returns focus to the editor', () => {
  const { doc, modal, last } = fixture()
  let dismissed = 0
  const close = activateModalFocus(asHtml(modal), () => dismissed++)
  last.focus()
  const confirm = new Element(doc, 'DIV', true)
  const cancel = new Element(doc, 'BUTTON'); confirm.append(cancel); doc.body.append(confirm); doc.mutate()
  assert.equal(doc.activeElement, cancel)
  assert.equal(modal.inert, true)
  doc.key('Escape'); assert.equal(dismissed, 0)
  confirm.remove(); doc.mutate()
  assert.equal(doc.activeElement, last)
  doc.key('Escape'); assert.equal(dismissed, 1)
  close(); modal.remove()
})

test('orientation priority blocks even new portals, then resumes the editor', () => {
  const { doc, modal, last } = fixture()
  const close = activateModalFocus(asHtml(modal))
  last.focus()
  const gate = new Element(doc, 'DIV', true); doc.body.append(gate)
  const resume = activateModalFocus(asHtml(gate), undefined, 100)
  assert.equal(doc.activeElement, gate)
  const latePortal = new Element(doc, 'DIV', true)
  latePortal.append(new Element(doc, 'BUTTON')); doc.body.append(latePortal); doc.mutate()
  assert.equal(latePortal.inert, true)
  assert.equal(doc.activeElement, gate)
  latePortal.remove(); resume(); gate.remove(); doc.mutate()
  assert.equal(doc.activeElement, last)
  close(); modal.remove()
})

test('popover cleanup cannot steal focus from next dialog or lose the original opener', async () => {
  const { doc, modal, opener } = fixture()
  const closePopover = activateModalFocus(asHtml(modal))
  closePopover(); modal.remove()
  const editor = new Element(doc, 'DIV', true)
  const input = new Element(doc, 'BUTTON'); editor.append(input); doc.body.append(editor)
  const closeEditor = activateModalFocus(asHtml(editor))
  await Promise.resolve()
  assert.equal(doc.activeElement, input)
  closeEditor(); editor.remove(); await Promise.resolve()
  assert.equal(doc.activeElement, opener)
})

test('an autoFocus input preserves the opener captured before the portal commit', async () => {
  const { doc, modal, opener, last } = fixture()
  last.focus()
  const close = activateModalFocus(asHtml(modal), undefined, 0, asHtml(opener))
  assert.equal(doc.activeElement, last)
  close(); modal.remove(); await Promise.resolve()
  assert.equal(doc.activeElement, opener)
})
