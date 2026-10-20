import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { withBoardLease } from './boardLeaseActions.js'

/**
 * ⚠️ Аренда — доказательство единоличной правки, а не право писать. Значит
 * действие обязано БРАТЬ её само. Кнопки звали стор напрямую, а он без аренды
 * МОЛЧА возвращается: сперва так умерло «Убрать» на карточке-заглушке
 * (08.09.2026), потом — «Удалить» и Delete у обычного объекта (09.09.2026
 * «почему я не могу удалить на сетевой доске»).
 */
test('действие сначала берёт аренду', async () => {
  const asked: string[][] = []
  let done = false
  const store = {
    withSelection: async (ids: readonly string[], work: () => void | Promise<void>) => {
      asked.push([...ids])
      await work()
      return true
    },
  }
  assert.equal(await withBoardLease(store as never, 'pending_1', () => { done = true }), true)
  assert.equal(await withBoardLease(store as never, ['a', 'b'], () => {}), true)
  assert.deepEqual(asked, [['pending_1'], ['a', 'b']], 'один объект и пачка — один и тот же путь')
  assert.equal(done, true)
})

test('аренду не дали — действие не выполняется, и об этом говорят', async () => {
  let done = false
  const store = { withSelection: async () => false }
  assert.equal(await withBoardLease(store as never, 'pending_1', () => { done = true }), false)
  assert.equal(done, false, 'без аренды объект не трогаем')
})

/**
 * ⚠️ Молчащая кнопка хуже отказа: об отказе можно хотя бы спросить. Оба места,
 * где убирают карточку-заглушку, обязаны брать аренду и объяснять отказ.
 */
test('обе карточки — на компьютере и на планшете — ходят через аренду', async () => {
  const desktop = await readFile(new URL('./PendingItem.tsx', import.meta.url), 'utf8')
  assert.match(desktop, /withBoardLease\(store, p\.id, \(\) => store\.dismissPendingById/)
  assert.match(desktop, /withBoardLease\(store, p\.id, async \(\) => \{/, 'повтор тоже правит карточку')
  assert.ok(desktop.includes('PENDING_LEASE_REFUSED'), 'отказ объясняется словами')

  const tablet = await readFile(
    new URL('../../../tablet/BoardItemView.tsx', import.meta.url), 'utf8',
  )
  assert.match(tablet, /withBoardLease\(store, item\.id, \(\) => store\.dismissPendingById/)
  assert.ok(tablet.includes('PENDING_LEASE_REFUSED'), 'отказ объясняется словами')
})

/**
 * ⚠️ Пункт меню гасит только ЖИВОЙ коллега (looksEditable), а не отсутствие
 * своей аренды: она истекает молча — продление теряется от притормозившей
 * вкладки, смены канала, отброшенного кадра, — и человек оставался с
 * выделенной картинкой, у которой не работает ни один пункт.
 */
test('контекстное меню не гасит пункты из-за своей аренды', async () => {
  const menu = await readFile(new URL('./ContextMenu.tsx', import.meta.url), 'utf8')
  assert.ok(
    !menu.includes('store.canMutateItems'),
    'вид решает looksEditable, право берёт само действие',
  )
  assert.match(menu, /const canMutateTarget = !menu\.itemId \|\| store\.looksEditable/)
  assert.match(menu, /const canMutateSelection = store\.looksEditable/)
  for (const call of [
    /runOwned\(\[\.\.\.store\.getSelectedIds\(\)\], \(\) => store\.removeSelected\(\)\)/,
    /runOwned\(\[\.\.\.store\.getSelectedIds\(\)\], \(\) => store\.bringToFront/,
    /runOwned\(\[\.\.\.store\.getSelectedIds\(\)\], \(\) => store\.sendToBack/,
    /runOwned\(archiveTargets\(store, item\.id\), \(\) => \{ archiveSelection/,
    /runOwned\(\[item\.id\], \(\) => setCropTarget/,
    /runOwned\(\[item\.id\], \(\) => setSketchTarget/,
  ]) assert.match(menu, call)
})

/** Клавиша обязана делать то же, что пункт меню, — иначе Delete «не работает». */
test('Delete, Shift+Del и Ctrl+X тоже берут аренду', async () => {
  const hotkeys = await readFile(new URL('./useCanvasHotkeys.ts', import.meta.url), 'utf8')
  const leased = hotkeys.match(/runWithBoardLease\(/g) ?? []
  assert.equal(leased.length, 3, 'вырезать, в архив, удалить')
  assert.ok(
    !/\n\s*store\.removeSelected\(\)/.test(hotkeys),
    'прямого вызова без аренды не осталось',
  )
})

/**
 * ⚠️ Планшет говорил «Удалено: 1 объект», когда стор молча возвращался без
 * аренды: сообщение об успехе обязано стоять ВНУТРИ действия.
 */
test('планшет удаляет и архивирует через аренду, а хвалится после', async () => {
  const actions = await readFile(
    new URL('../../../tablet/useBoardActions.ts', import.meta.url), 'utf8',
  )
  assert.match(actions, /runWithBoardLease\(store, ids, \(\) => \{\s*\n\s*store\.removeItems\(ids\)\s*\n\s*notify\(/)
  assert.match(actions, /runWithBoardLease\(store, ids, \(\) => \{\s*\n\s*const moved = store\.archiveItems\(ids\)/)
  assert.match(actions, /runWithBoardLease\(store, ids, \(\) => store\.bringToFront\(ids\)\)/)
  assert.match(actions, /runWithBoardLease\(store, ids, \(\) => store\.sendToBack\(ids\)\)/)
})

/**
 * ⚠️ Ctrl+Z ломался тем же образом: `undo` спрашивал свою аренду НА ВЫДЕЛЕНИЕ,
 * а отмена применяет целый снимок — взять аренду на нужные объекты тут нечем.
 * Отказ по истёкшей аренде означал, что отмена молча перестаёт работать, стоит
 * что-нибудь выделить. Спрашиваем только про ЖИВОГО коллегу; отказать в самой
 * правке по-прежнему вправе сервер.
 */
test('отмена и возврат не спрашивают свою аренду', async () => {
  const store = await readFile(new URL('./canvasStore.ts', import.meta.url), 'utf8')
  assert.match(store, /undo\(\): boolean \{[\s\S]*?this\.looksEditable\(\[\.\.\.this\.selected\]\)/)
  assert.match(store, /redo\(\): void \{\s*(?:this\.finalizeArrangePreview\(\)\s*)?if \(this\.collaboration && !this\.looksEditable\(\[\.\.\.this\.selected\]\)\) return/)
  assert.ok(
    !/this\.collaboration && !this\.canMutateItems\(\[\.\.\.this\.selected\]\)/.test(store),
    'прежней проверки по своей аренде не осталось',
  )
})
