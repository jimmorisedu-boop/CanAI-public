import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasStore } from './canvasStore'
import { armLostDragEndSafety } from './dragEndSafety'
import { beginGroupDrag, commitGroupDrag, groupDragFollowers, groupDragPositions, isGroupDragMember, moveGroupDrag } from './groupDrag'

class FakeNode {
  constructor(private nodeId: string, private px: number, private py: number) {}
  id() { return this.nodeId }
  x() { return this.px }
  y() { return this.py }
  position(next?: { x: number; y: number }) {
    if (next) { this.px = next.x; this.py = next.y }
    return { x: this.px, y: this.py }
  }
}

class FakeWindowEvents {
  private listeners = new Map<string, EventListener[]>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener !== 'function') return
    const current = this.listeners.get(type) ?? []
    current.push(listener)
    this.listeners.set(type, current)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener !== 'function') return
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener))
  }

  dispatch(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener.call(this, { type } as Event)
    }
  }
}

test('перенос выделения сохраняет точные интервалы между объектами', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [
      { id: 'a', kind: 'image', x: 10, y: 20, w: 100, h: 80, src: '/media/a.png' },
      { id: 'b', kind: 'image', x: 145, y: 20, w: 100, h: 80, src: '/media/b.png' },
      { id: 'c', kind: 'image', x: 280, y: 20, w: 100, h: 80, src: '/media/c.png' },
    ],
  })
  store.setSelection(['a', 'b', 'c'])
  const nodes = [new FakeNode('a', 10, 20), new FakeNode('b', 145, 20), new FakeNode('c', 280, 20)]
  const session = beginGroupDrag(store, 'a', nodes)

  nodes[0].position({ x: 73.25, y: -18.5 })
  moveGroupDrag(session)

  assert.deepEqual(nodes.map((node) => node.position()), [
    { x: 73.25, y: -18.5 },
    { x: 208.25, y: -18.5 },
    { x: 343.25, y: -18.5 },
  ])
  commitGroupDrag(store, session)
  assert.deepEqual(store.getSelectedItems().map(({ x, y }) => ({ x, y })), nodes.map((node) => node.position()))

  store.undo()
  assert.deepEqual(store.getSelectedItems().map(({ x, y }) => ({ x, y })), [
    { x: 10, y: 20 },
    { x: 145, y: 20 },
    { x: 280, y: 20 },
  ])
})

test('переносит всё выделение, даже если одна Konva-нода ещё не смонтирована', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [
      { id: 'a', kind: 'image', x: 10, y: 20, w: 100, h: 80, src: '/media/a.png' },
      { id: 'b', kind: 'image', x: 145, y: 20, w: 100, h: 80, src: '/media/b.png' },
      { id: 'c', kind: 'image', x: 280, y: 20, w: 100, h: 80, src: '/media/c.png' },
    ],
  })
  store.setSelection(['a', 'b', 'c'])
  // Во время пересборки/culling DOM одна из выбранных нод может отсутствовать
  // ровно в момент dragStart. Это не должно превращать перенос группы в
  // частичный и разрушать уже выстроенный ряд.
  const nodes = [new FakeNode('a', 10, 20), new FakeNode('b', 145, 20)]
  const session = beginGroupDrag(store, 'a', nodes)

  nodes[0].position({ x: 73.25, y: -18.5 })
  moveGroupDrag(session)
  commitGroupDrag(store, session)

  assert.deepEqual(store.getSelectedItems().map(({ x, y }) => ({ x, y })), [
    { x: 73.25, y: -18.5 },
    { x: 208.25, y: -18.5 },
    { x: 343.25, y: -18.5 },
  ])
})

test('не сохраняет случайный сдвиг ведомой ноды между dragmove и dragend', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [
      { id: 'a', kind: 'image', x: 10, y: 20, w: 100, h: 80, src: '/media/a.png' },
      { id: 'b', kind: 'image', x: 145, y: 20, w: 100, h: 80, src: '/media/b.png' },
    ],
  })
  store.setSelection(['a', 'b'])
  const nodes = [new FakeNode('a', 10, 20), new FakeNode('b', 145, 20)]
  const session = beginGroupDrag(store, 'a', nodes)

  nodes[0].position({ x: 73.25, y: -18.5 })
  moveGroupDrag(session)
  // React/Konva успел вернуть ведомую ноду к props до dragEnd.
  nodes[1].position({ x: 145, y: 20 })
  commitGroupDrag(store, session)

  assert.deepEqual(store.getSelectedItems().map(({ x, y }) => ({ x, y })), [
    { x: 73.25, y: -18.5 },
    { x: 208.25, y: -18.5 },
  ])
})

test('одиночный drag остаётся обычным переносом', () => {
  const store = new CanvasStore()
  store.loadDoc({ version: 1, camera: { x: 0, y: 0, scale: 1 }, items: [
    { id: 'a', kind: 'image', x: 10, y: 20, w: 100, h: 80, src: '/media/a.png' },
  ] })
  store.setSelection(['a'])
  const node = new FakeNode('a', 10, 20)
  const session = beginGroupDrag(store, 'a', [node])
  node.position({ x: 50, y: 60 })
  moveGroupDrag(session)
  commitGroupDrag(store, session)
  assert.deepEqual({ x: store.getItem('a')?.x, y: store.getItem('a')?.y }, { x: 50, y: 60 })
})

test('страховка не сохраняет координаты раньше Konva dragEnd', () => {
  const events = new FakeWindowEvents()
  let dragActive = true
  let savedPosition = { x: 10, y: 20 }

  // Konva регистрирует mouseup-listener раньше itemHelpers.
  events.addEventListener('mouseup', () => { dragActive = false })
  armLostDragEndSafety(events, () => {
    if (dragActive) savedPosition = { x: 180, y: 220 }
  })

  // В браузере pointerup приходит раньше совместимого mouseup.
  events.dispatch('pointerup')
  events.dispatch('mouseup')

  assert.deepEqual(savedPosition, { x: 10, y: 20 })
})

test('страховка завершает потерянный dragEnd, но touchcancel отменяет жест', () => {
  for (const event of ['mouseup', 'touchend']) {
    const events = new FakeWindowEvents()
    let fallbackCalls = 0
    let cancelCalls = 0
    armLostDragEndSafety(events, () => { fallbackCalls += 1 }, () => { cancelCalls += 1 })

    events.dispatch(event)
    events.dispatch(event)

    assert.equal(fallbackCalls, 1, event)
    assert.equal(cancelCalls, 0, event)
  }
  const cancelled = new FakeWindowEvents()
  let fallbackCalls = 0
  let cancelCalls = 0
  armLostDragEndSafety(cancelled, () => { fallbackCalls += 1 }, () => { cancelCalls += 1 })
  cancelled.dispatch('touchcancel')
  cancelled.dispatch('touchcancel')
  assert.equal(fallbackCalls, 0)
  assert.equal(cancelCalls, 1)
})

/**
 * ⚠️ Konva Transformer ведёт все выделенные ноды сам и шлёт dragstart/dragend
 * КАЖДОЙ из них. Раньше обработчик открывал новую сессию на каждый dragstart,
 * поэтому лидером оказывалась последняя нода, групповая фиксация не срабатывала
 * ни для кого, и каждая нода писала себя отдельным updateItem: взаимные
 * расстояния расходились (накапливаясь с каждым переносом), а одно
 * перетаскивание давало столько шагов отмены, сколько объектов в выделении.
 *
 * Правило: сессия у жеста одна, группу пишет ПЕРВЫЙ пришедший dragend, а все
 * остальные участники молчат.
 */
test('группу пишет один dragend, остальные участники молчат', () => {
  const store = new CanvasStore()
  store.loadDoc({
    version: 1,
    camera: { x: 0, y: 0, scale: 1 },
    items: [
      { id: 'a', kind: 'text', x: 0, y: 0, w: 100, h: 40, text: 'A' },
      { id: 'b', kind: 'text', x: 200, y: 0, w: 100, h: 40, text: 'B' },
      { id: 'c', kind: 'text', x: 400, y: 0, w: 100, h: 40, text: 'C' },
    ],
  })
  store.select('a', false)
  store.select('b', true)
  store.select('c', true)
  const nodes = [new FakeNode('a', 0, 0), new FakeNode('b', 200, 0), new FakeNode('c', 400, 0)]
  // схвачен средний объект
  const session = beginGroupDrag(store, 'b', nodes)

  assert.equal(isGroupDragMember(session, 'a'), true)
  assert.equal(isGroupDragMember(session, 'c'), true)
  assert.equal(isGroupDragMember(session, 'нет-такого'), false)

  // dragend может прийти от любого участника, не только от лидера
  assert.deepEqual(groupDragFollowers(session, 'c').sort(), ['a', 'b'])
  assert.deepEqual(groupDragFollowers(session, 'b').sort(), ['a', 'c'])

  nodes[1].position({ x: 260, y: 40 })
  moveGroupDrag(session)
  const positions = groupDragPositions(session)
  const dx = positions.map((p) => p.x - (store.getItem(p.id)?.x ?? 0))
  const dy = positions.map((p) => p.y - (store.getItem(p.id)?.y ?? 0))
  assert.deepEqual([...new Set(dx)], [60], 'все объекты смещены одним вектором по x')
  assert.deepEqual([...new Set(dy)], [40], 'все объекты смещены одним вектором по y')

  commitGroupDrag(store, session)
  assert.deepEqual(
    store.getSelectableItems().map((item) => ({ id: item.id, x: item.x, y: item.y })),
    [{ id: 'a', x: 60, y: 40 }, { id: 'b', x: 260, y: 40 }, { id: 'c', x: 460, y: 40 }],
  )
  // взаимные расстояния целы
  const items = store.getSelectableItems()
  assert.equal(items[1].x - items[0].x, 200)
  assert.equal(items[2].x - items[1].x, 200)
})
