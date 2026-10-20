import { useLayoutEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
type Scope = { root: HTMLElement; dismiss?: () => void; priority: number; previous: HTMLElement | null }

// One owner of inert and keyboard focus across tablet portals. The existing
// ConfirmHost is also a modal; it participates without needing a second host.
class ModalScopes {
  scopes: Scope[] = []
  ignored = new WeakSet<HTMLElement>()
  returns = new Map<HTMLElement, HTMLElement | null>()
  remembered = new WeakMap<HTMLElement, HTMLElement>()
  inert = new Map<HTMLElement, boolean>()
  top: HTMLElement | null = null
  observer?: MutationObserver
  focusing = false
  constructor(readonly doc: Document) {}

  restoreInert() {
    for (const [node, value] of this.inert) node.inert = value
    this.inert.clear()
  }

  current() {
    const modals = Array.from(this.doc.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
      .filter(node => !this.ignored.has(node) && !node.hidden && node.getClientRects().length > 0)
    const pinned = this.scopes.filter(scope => scope.priority > 0 && modals.includes(scope.root))
      .sort((a, b) => a.priority - b.priority).at(-1)
    return pinned?.root ?? modals.at(-1) ?? null
  }

  focusables(root: HTMLElement) {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(node => node.tabIndex >= 0 && !node.closest('[inert], [hidden]') && node.getClientRects().length > 0)
  }

  focus(root: HTMLElement) {
    const remembered = this.remembered.get(root)
    const target = remembered?.isConnected && root.contains(remembered) && !remembered.closest('[inert], [hidden]')
      ? remembered : this.focusables(root)[0] ?? root
    this.focusing = true
    target.focus({ preventScroll: true })
    this.focusing = false
  }

  refresh = () => {
    this.restoreInert()
    const active = this.doc.activeElement as HTMLElement | null
    if (this.top && active && this.top.contains(active)) this.remembered.set(this.top, active)
    this.top = this.current()
    if (!this.top) return
    // Keep the modal's backdrop available, but every sibling branch inert.
    let branch: HTMLElement = this.top
    while (branch.parentElement) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling === branch) continue
        const node = sibling as HTMLElement
        this.inert.set(node, node.inert)
        node.inert = true
      }
      branch = branch.parentElement
      if (branch === this.doc.body) break
    }
    if (!this.top.contains(active)) this.focus(this.top)
  }

  onFocus = (event: FocusEvent) => {
    const top = this.current()
    if (!top || this.focusing) return
    if (top.contains(event.target as Node)) this.remembered.set(top, event.target as HTMLElement)
    else this.focus(top)
  }

  onKey = (event: KeyboardEvent) => {
    const top = this.current()
    if (!top) return
    if (event.key === 'Escape') {
      const scope = this.scopes.find(scope => scope.root === top)
      // External ConfirmHost owns its own Escape action.
      if (!scope) return
      event.preventDefault()
      event.stopImmediatePropagation()
      scope.dismiss?.()
    } else if (event.key === 'Tab') {
      const nodes = this.focusables(top)
      const active = this.doc.activeElement
      if (nodes.length === 0 || !top.contains(active) || active === top ||
          (event.shiftKey ? active === nodes[0] : active === nodes.at(-1))) {
        event.preventDefault()
        event.stopImmediatePropagation()
        ;(event.shiftKey ? nodes.at(-1) ?? top : nodes[0] ?? top).focus({ preventScroll: true })
      }
    }
  }

  resolvePrevious(node: HTMLElement | null): HTMLElement | null {
    const seen = new Set<HTMLElement>()
    while (node && !node.isConnected && !seen.has(node)) {
      seen.add(node)
      const owner = Array.from(this.returns).find(([root]) => root.contains(node))
      node = owner?.[1] ?? null
    }
    return node
  }

  add(root: HTMLElement, dismiss?: () => void, priority = 0, origin = this.doc.activeElement as HTMLElement | null) {
    const previous = this.resolvePrevious(origin)
    const scope: Scope = { root, dismiss, priority, previous }
    this.ignored.delete(root)
    this.scopes.push(scope)
    this.returns.set(root, previous)
    if (this.scopes.length === 1) {
      this.doc.addEventListener('keydown', this.onKey, true)
      this.doc.addEventListener('focusin', this.onFocus, true)
      const Observer = this.doc.defaultView?.MutationObserver
      if (Observer) {
        this.observer = new Observer(this.refresh)
        this.observer.observe(this.doc.body, { childList: true, subtree: true })
      }
    }
    this.refresh()
    return () => {
      this.scopes = this.scopes.filter(value => value !== scope)
      this.ignored.add(root)
      this.refresh()
      if (this.scopes.length === 0) {
        this.observer?.disconnect()
        this.doc.removeEventListener('keydown', this.onKey, true)
        this.doc.removeEventListener('focusin', this.onFocus, true)
        this.restoreInert()
      }
      queueMicrotask(() => {
        const active = this.doc.activeElement
        // A next editor may have claimed focus during this same React commit.
        if (this.current()) return
        if (!active || active === this.doc.body || !active.isConnected || root.contains(active)) {
          this.resolvePrevious(scope.previous)?.focus({ preventScroll: true })
        }
        if (this.scopes.length === 0) this.returns.clear()
      })
    }
  }
}

const managers = new WeakMap<Document, ModalScopes>()
export function activateModalFocus(root: HTMLElement, onDismiss?: () => void, priority = 0, origin?: HTMLElement | null): () => void {
  let manager = managers.get(root.ownerDocument)
  if (!manager) {
    manager = new ModalScopes(root.ownerDocument)
    managers.set(root.ownerDocument, manager)
  }
  return manager.add(root, onDismiss, priority, origin)
}

export function isActiveModal(root: HTMLElement): boolean {
  return managers.get(root.ownerDocument)?.current() === root
}

export function useModalFocus(ref: RefObject<HTMLElement | null>, onDismiss?: () => void, priority = 0, active = true): void {
  const dismiss = useRef(onDismiss)
  // Capture before React commits an autoFocus input inside the new portal.
  // A host such as ConfirmHost stays mounted while its portal is absent, so
  // `active` also marks the transition at which the opener must be captured.
  const origin = useRef<HTMLElement | null>(null)
  const wasActive = useRef(false)
  dismiss.current = onDismiss
  if (active && !wasActive.current && !origin.current && typeof document !== 'undefined') {
    origin.current = document.activeElement as HTMLElement | null
  }
  useLayoutEffect(() => {
    if (!active) {
      wasActive.current = false
      origin.current = null
      return
    }
    const root = ref.current
    if (!root) return
    if (!origin.current && typeof document !== 'undefined') origin.current = document.activeElement as HTMLElement | null
    wasActive.current = true
    return activateModalFocus(root, () => dismiss.current?.(), priority, origin.current)
  }, [ref, priority, active])
}
