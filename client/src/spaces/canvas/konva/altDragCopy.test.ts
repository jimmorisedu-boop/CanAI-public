import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  ALT_COPY_GHOST, ALT_COPY_GHOST_LIMIT, altCopyIds, altKeyBelongsToCanvas, commitAltCopy, holdUncopied,
  isAltCopying, releaseAltCopy, resetAltCopy, syncAltCopy, wantsAltCopy,
} from './altDragCopy'
import { CanvasStore } from './canvasStore'
import type { CanvasMutationEnvelope } from './canvasMutations'
import { beginGroupDrag, moveGroupDrag } from './groupDrag'
import { applySnapGuides } from './snapGuides'
import type { CanvasItem } from './types'

// Просьба 01.10.2026: «нужно чтобы контент копировался с зажатой клавишей
// альт». Потащил объект с Alt — исходник остаётся на месте, копия встаёт
// туда, куда её привели (как в Figma и Photoshop).

;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??=
  ((cb: () => void) => setTimeout(cb, 0)) as typeof requestAnimationFrame

const source = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8')

function board(items: Array<{ id: string; x: number; y: number; w?: number; h?: number }>): CanvasStore {
  const store = new CanvasStore()
  for (const item of items) {
    store.addItem({ w: 100, h: 100, ...item, kind: 'text', text: item.id } as unknown as CanvasItem)
  }
  return store
}

/** Слой Konva в миниатюре: дети по порядку, счётчик перерисовок, курсор сцены. */
function scene() {
  const container = { style: { cursor: 'default' } }
  const layer = { draws: 0, batchDraw() { layer.draws += 1 } }
  const stage = { container: () => container }
  const children: Array<{ kind: 'node' | 'ghost'; id: string }> = []
  const parent = {
    children,
    add(child: { kind: 'node' | 'ghost'; id: string }) { children.push(child) },
  }
  function place(child: { kind: 'node' | 'ghost'; id: string }, index: number): void {
    children.splice(children.indexOf(child), 1)
    children.splice(index, 0, child)
  }
  function node(id: string, x: number, y: number) {
    let pos = { x, y }
    const self = {
      kind: 'node' as const,
      id: () => id,
      x: () => pos.x,
      y: () => pos.y,
      position(next?: { x: number; y: number }) {
        if (next) pos = { ...next }
        return pos
      },
      getParent: () => parent,
      getLayer: () => layer,
      getStage: () => stage,
      zIndex: () => children.indexOf(self as never),
      clone(attrs: Record<string, unknown>) {
        const ghost = {
          kind: 'ghost' as const,
          id: `ghost-of-${id}`,
          attrs,
          destroyed: false,
          zIndex(index: number) { place(ghost as never, index) },
          destroy() {
            ghost.destroyed = true
            children.splice(children.indexOf(ghost as never), 1)
          },
        }
        return ghost
      },
    }
    children.push(self as never)
    return self
  }
  return { container, layer, parent, node, order: () => children.map((child) => `${child.kind}:${typeof child.id === 'function' ? (child.id as () => string)() : child.id}`) }
}

/** Жест: выделение `ids`, схвачен `leader`, ноды стоят там же, где объекты в сторе. */
function gesture(store: CanvasStore, ids: string[], leader: string) {
  resetAltCopy()
  const view = scene()
  store.setSelection(ids)
  const all = [...store.getItems(), ...store.getPending()]
  const nodes = ids.map((id) => {
    const item = all.find((candidate) => candidate.id === id)!
    return view.node(id, item.x, item.y)
  })
  const session = beginGroupDrag(store, leader, nodes as never)
  const lead = nodes.find((candidate) => candidate.id() === leader)!
  const drag = (dx: number, dy: number) => {
    lead.position({ x: session.leaderX + dx, y: session.leaderY + dy })
    moveGroupDrag(session)
  }
  return { view, nodes, session, drag }
}

test('копии встают со сдвигом одной правкой, исходники не тронуты', () => {
  const store = board([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 }])
  store.updateItem('a', { externalEditSessionId: 'edit-1' } as Partial<CanvasItem>, false)
  const events: CanvasMutationEnvelope[] = []
  store.subscribeMutations((event) => events.push(event))

  const ids = store.duplicateWithOffset(['b', 'a'], 300, 50)

  assert.equal(store.getItems().length, 4)
  assert.deepEqual(store.getItems().slice(0, 2).map(({ id, x, y }) => ({ id, x, y })), [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 },
  ], 'исходники на месте')
  const copies = store.getItems().slice(2)
  assert.deepEqual(copies.map(({ x, y, text }) => ({ x, y, text })), [
    { x: 300, y: 50, text: 'a' }, { x: 500, y: 50, text: 'b' },
  ], 'копии в порядке слоёв исходников')
  assert.deepEqual(copies.map((copy) => copy.id), ids)
  assert.ok(copies.every((copy) => copy.externalEditSessionId === undefined), 'сеанс внешней правки остаётся у исходника')
  assert.deepEqual([...store.getSelectedIds()], ids, 'выделение переходит на копии')
  const sent = events.flatMap((event) => event.batch ?? [event])
  assert.equal(events.length, 1, 'одна правка на всю группу')
  assert.deepEqual(sent.map((entry) => entry.mutation.type), ['item.add', 'item.add'])

  store.undo()
  assert.deepEqual(store.getItems().map((item) => item.id), ['a', 'b'], 'один шаг отмены убирает все копии')
})

test('с Alt исходники видны на своих местах, без Alt — обычный перенос', () => {
  const store = board([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 }])
  const { view, session, drag } = gesture(store, ['a', 'b'], 'a')
  drag(40, 10)

  assert.equal(syncAltCopy(store, session, false), false)
  assert.deepEqual(view.order(), ['node:a', 'node:b'], 'без Alt призраков нет')

  assert.equal(syncAltCopy(store, session, true), true)
  assert.equal(isAltCopying(session), true)
  assert.deepEqual(view.order(), ['ghost:ghost-of-a', 'node:a', 'ghost:ghost-of-b', 'node:b'],
    'призрак лежит ровно под своим объектом')
  const ghost = view.parent.children[0] as unknown as { attrs: Record<string, unknown> }
  assert.deepEqual(ghost.attrs, {
    id: undefined, name: ALT_COPY_GHOST, x: 0, y: 0, listening: false, draggable: false,
  }, 'призрак стоит на месте исходника, без id и без событий')
  assert.equal(view.container.style.cursor, 'copy')
  const draws = view.layer.draws
  syncAltCopy(store, session, true)
  assert.equal(view.layer.draws, draws, 'пока клавиша в том же положении, ничего не делаем')
  assert.equal(view.parent.children.length, 4)

  // Передумали: Alt отпущен по дороге.
  assert.equal(syncAltCopy(store, session, false), false)
  assert.deepEqual(view.order(), ['node:a', 'node:b'])
  assert.equal(view.container.style.cursor, 'default', 'курсор возвращён')
  assert.equal(isAltCopying(session), false)
})

test('коллегам исходники никуда не едут: кадр жеста снимается', () => {
  const store = board([{ id: 'a', x: 0, y: 0 }])
  const { session } = gesture(store, ['a'], 'a')
  const previews: unknown[] = []
  const shared = {
    getItem: store.getItem,
    duplicateWithOffset: store.duplicateWithOffset.bind(store),
    getCollaboration: () => ({ setPreview: (value: unknown) => { previews.push(value) } }),
  }
  syncAltCopy(shared as never, session, true)
  assert.deepEqual(previews, [null])
  releaseAltCopy()
})

test('отпустили с Alt: исходники вернулись на места, копии встали там, куда привели', () => {
  const store = board([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 }])
  const { nodes, session, drag, view } = gesture(store, ['a', 'b'], 'b')
  syncAltCopy(store, session, true)
  drag(0, 300)
  assert.deepEqual(nodes.map((node) => node.position()), [{ x: 0, y: 300 }, { x: 200, y: 300 }])

  releaseAltCopy()
  const copies = commitAltCopy(store, session)

  assert.deepEqual(nodes.map((node) => node.position()), [{ x: 0, y: 0 }, { x: 200, y: 0 }], 'ноды исходников на месте')
  assert.deepEqual(view.order(), ['node:a', 'node:b'], 'призраков не осталось')
  assert.deepEqual(store.getItems().map(({ id, x, y }) => ({ id: id === 'a' || id === 'b' ? id : 'копия', x, y })), [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 },
    { id: 'копия', x: 0, y: 300 }, { id: 'копия', x: 200, y: 300 },
  ])
  assert.deepEqual([...store.getSelectedIds()], copies)
})

test('привели обратно на исходник — копии нет', () => {
  const store = board([{ id: 'a', x: 0, y: 0 }])
  const { session, drag } = gesture(store, ['a'], 'a')
  syncAltCopy(store, session, true)
  drag(0.2, -0.3)
  releaseAltCopy()
  assert.deepEqual(commitAltCopy(store, session), [])
  assert.equal(store.getItems().length, 1, 'невидимый двойник поверх исходника не нужен')
})

test('карточка генерации не копируется и с Alt остаётся на месте', () => {
  const store = board([{ id: 'a', x: 0, y: 0 }])
  const [card] = store.addPendingRow(1, { kind: 'image', label: 'Проба' })
  const before = store.getPending()[0]!
  const { nodes, session, drag, view } = gesture(store, ['a', card!], 'a')
  assert.deepEqual(altCopyIds(store, session), ['a'])

  syncAltCopy(store, session, true)
  drag(500, 0)
  holdUncopied(store, session)
  assert.deepEqual(nodes[1]!.position(), { x: before.x, y: before.y }, 'карточка не уехала за группой')
  assert.deepEqual(view.order().filter((entry) => entry.startsWith('ghost')), ['ghost:ghost-of-a'], 'призрак ей не нужен')

  releaseAltCopy()
  commitAltCopy(store, session)
  assert.equal(store.getPending().length, 1, 'второй карточки не появилось')
  assert.equal(store.getItems().length, 2)

  // Схватили саму карточку — Alt ничего не меняет: это обычный перенос.
  const grabbed = gesture(store, ['a', card!], card!)
  assert.equal(wantsAltCopy(store, grabbed.session, true), false)
  assert.equal(syncAltCopy(store, grabbed.session, true), false)
})

test('призраков не больше предела — копия при этом всё равно состоится', () => {
  const count = ALT_COPY_GHOST_LIMIT + 5
  const store = board(Array.from({ length: count }, (_, index) => ({ id: `i${index}`, x: index * 10, y: 0 })))
  const ids = store.getItems().map((item) => item.id)
  const { view, session, drag } = gesture(store, ids, 'i0')
  syncAltCopy(store, session, true)
  assert.equal(view.order().filter((entry) => entry.startsWith('ghost')).length, ALT_COPY_GHOST_LIMIT)
  drag(0, 400)
  releaseAltCopy()
  assert.equal(commitAltCopy(store, session).length, count)
})

test('отпускание Alt после жеста не уходит браузеру, а в остальное время клавиша не наша', () => {
  resetAltCopy()
  assert.equal(altKeyBelongsToCanvas('keydown', false), false, 'Alt без переноса — не наш')
  assert.equal(altKeyBelongsToCanvas('keyup', false), false)

  // Alt зажат до нажатия мыши, отпущен уже после неё — обычный порядок.
  const store = board([{ id: 'a', x: 0, y: 0 }])
  const { session } = gesture(store, ['a'], 'a')
  syncAltCopy(store, session, true)
  releaseAltCopy()
  assert.equal(altKeyBelongsToCanvas('keyup', false), true, 'иначе Chrome увёл бы фокус в своё меню')
  assert.equal(altKeyBelongsToCanvas('keyup', false), false, 'долг гасится один раз')

  // Alt нажали посреди жеста.
  assert.equal(altKeyBelongsToCanvas('keydown', true), true)
  assert.equal(altKeyBelongsToCanvas('keyup', true), true)
})

test('копия липнет к своему исходнику — так и ставят ровный ряд', () => {
  const store = board([{ id: 'a', x: 0, y: 0 }])
  store.setSelection(['a'])
  const handle = (x: number, y: number) => {
    let pos = { x, y }
    return { x: () => pos.x, y: () => pos.y, position: (next?: { x: number; y: number }) => (next ? (pos = next) : pos) }
  }

  // Обычный перенос к собственному месту не липнет: его там уже нет.
  const moved = handle(300, 3)
  applySnapGuides(store, 'a', moved as never)
  assert.deepEqual(moved.position(), { x: 300, y: 3 })

  // Копия держит линию исходника.
  const copy = handle(300, 3)
  applySnapGuides(store, 'a', copy as never, { ownPlaces: true })
  assert.deepEqual(copy.position(), { x: 300, y: 0 })
  assert.ok(store.getGuides().length > 0, 'направляющая показывает, к чему прилипло')
})

test('жест доведён до холста: движение, отпускание, потерянный dragend и клавиша', async () => {
  const helpers = await source('itemHelpers.ts')
  const move = helpers.slice(helpers.indexOf('export function onCanvasItemDragMove'), helpers.indexOf('function publishDragOffset'))
  assert.match(move, /const copying = active \? syncAltCopy\(store, active, altHeld\(e\)\) : false/)
  assert.match(move, /applySnapGuides\(store, id, e\.target, \{ ownPlaces: copying \}\)/)
  assert.match(move, /if \(groupDrag\?\.leader === e\.target && !copying\) \{/, 'кадры жеста с копией не шлём')

  const end = helpers.slice(helpers.indexOf('export function onDragEnd'), helpers.indexOf('export function onTransformEnd'))
  assert.match(end, /wantsAltCopy\(store, session!, altHeld\(e\)\)/, 'решает Alt в миг отпускания')
  assert.ok(end.indexOf('releaseAltCopy()') < end.indexOf('if (!store.looksEditable(movingIds))'),
    'призраки убираются до того, как ветки отпускания расходятся')
  const copyBranch = end.slice(end.indexOf('if (copying && session) {'))
  assert.ok(copyBranch.indexOf('commitAltCopy(store, session)') > 0)
  assert.ok(copyBranch.indexOf('commitAltCopy(store, session)') < copyBranch.indexOf('const dropped ='),
    'копия ставится вместо записи переноса')
  assert.match(end, /if \(!copying && item && point && overArchive\(point\)\) \{/,
    'с Alt исходник остаётся на доске — в архив его не увозим')
  assert.match(move, /notifyArchiveHover\(Boolean\(!copying && /, 'и плитка архива при копировании не зовёт')
  assert.ok(end.indexOf('tryPinToAssetBar(') < end.indexOf('if (copying && session) {'),
    'полка и промпт-бар исходник и так не трогают — их правила прежние')

  const begin = helpers.slice(helpers.indexOf('function beginCanvasGroupDrag'), helpers.indexOf('function altHeld'))
  assert.match(begin, /const copying = isAltCopying\(session\)\s+releaseAltCopy\(\)\s+if \(copying\) commitAltCopy\(store, session\)\s+else commitGroupDrag\(store, session\)/)
  assert.match(begin, /registerActiveDrag\(store, \(\) => \{[^}]*releaseAltCopy\(\)/s, 'отмена жеста убирает призраков')
  assert.match(begin, /syncAltCopy\(store, session, alt\)/, 'Alt, зажатый до нажатия мыши, виден с первого кадра')
  assert.equal((helpers.match(/beginCanvasGroupDrag\(store, id, e\.target, altHeld\(e\)\)/g) ?? []).length, 4,
    'каждое начало жеста передаёт положение клавиши')

  assert.match(await source('KonvaCanvas.tsx'), /useEffect\(\(\) => installAltCopyKeys\(store\), \[store\]\)/)
  assert.match(await readFile(new URL('../../../ui/hotkeys.ts', import.meta.url), 'utf8'), /id: 'canvas\.dragCopy'/,
    'жест описан в справке по клавишам')
})
