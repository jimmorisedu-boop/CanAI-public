import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  beginRelease,
  beginSession,
  endSession,
  holdAction,
  HOLD_REPEAT_MS,
  HOLD_START_MS,
  swipeAction,
  TAP_MAX_MS,
  TAP_MAX_MOVE_PX,
  TAP_MAX_SPREAD_PX,
  THREE_FINGER_TAP_MAX_MS,
  tapAction,
  touchCenter,
  touchShape,
  trackHold,
  trackMove,
  sessionStill,
} from './boardFingerGestures.js'

const still = (x: number, y: number, spread = 40) => ({ center: { x, y }, spread })

/**
 * Жесты взяты из привычек iPadOS и рисовалок (просьба пользователя
 * 08.09.2026): два пальца тапом — отменить, три — вернуть, удержание
 * повторяет, три вниз — копирование, четыре тапом — убрать интерфейс.
 * Своего языка жестов заводить не стали.
 */
test('число пальцев решает, что за действие', () => {
  assert.equal(tapAction(2), 'undo')
  assert.equal(tapAction(3), 'redo')
  assert.equal(tapAction(4), 'chrome')
  assert.equal(tapAction(1), null, 'один палец занят выделением и холстом')
  assert.equal(tapAction(5), null)

  assert.equal(holdAction(2), 'undo')
  assert.equal(holdAction(3), 'redo')
  // ⚠️ Четыре пальца не повторяются: «убрать интерфейс» — переключатель, и
  // повтор превратил бы его в мигание.
  assert.equal(holdAction(4), null)
})

test('свайп тремя пальцами различает стороны и низ', () => {
  assert.equal(swipeAction(3, -120, 10), 'undo')
  assert.equal(swipeAction(3, 120, -10), 'redo')
  assert.equal(swipeAction(3, 8, 120), 'clipboard')
  // Вверх не занято намеренно: там системные жесты Safari.
  assert.equal(swipeAction(3, 0, -120), null)
  // Короткий ход — ещё не свайп.
  assert.equal(swipeAction(3, -30, 0), null)
  // Вниз с уклоном влево — всё ещё вниз: ход вниз явно больше.
  assert.equal(swipeAction(3, -120, 200), 'clipboard')
  // А вот ровно наискось — ничего: гадать, чего хотел человек, хуже, чем
  // не сделать ничего.
  assert.equal(swipeAction(3, -120, 120), null)
  // Двумя пальцами возят и щиплют холст — свайпов там нет.
  assert.equal(swipeAction(2, -120, 0), null)
})

/**
 * ⚠️ Два пальца — это ещё и панорама с щипком. Поэтому решает движение: пока
 * пальцы стоят, это отмена; поехали — доска едет, и отмены быть не должно.
 */
test('движение отменяет удержание, неподвижность — нет', () => {
  const stillHold = beginSession(2, still(100, 100), 0)!
  assert.equal(trackHold(stillHold, HOLD_START_MS - 1), null, 'раньше срока молчим')
  assert.equal(trackHold(stillHold, HOLD_START_MS), 'undo')
  assert.equal(trackHold(stillHold, HOLD_START_MS + HOLD_REPEAT_MS - 1), null, 'не чаще срока')
  assert.equal(trackHold(stillHold, HOLD_START_MS + HOLD_REPEAT_MS), 'undo', 'и повторяется')

  const moved = beginSession(2, still(100, 100), 0)!
  trackMove(moved, still(140, 100), 10)
  assert.equal(trackHold(moved, HOLD_START_MS), null, 'пальцы поехали — это панорама')
})

test('свайп срабатывает один раз за касание', () => {
  const session = beginSession(3, still(300, 300), 0)!
  assert.equal(trackMove(session, still(300 - 90, 305), 60), 'undo')
  // Иначе долгий свайп отматывал бы историю до начала доски, пока палец едет.
  assert.equal(trackMove(session, still(300 - 200, 305), 90), null)
})

test('тап засчитывается только коротким и неподвижным', () => {
  const quick = beginSession(2, still(10, 10), 0)!
  assert.equal(endSession(quick, 100), 'undo')

  const slow = beginSession(2, still(10, 10), 0)!
  assert.equal(endSession(slow, TAP_MAX_MS + 1), null, 'долгое касание — не тап')

  const shifted = beginSession(2, still(10, 10), 0)!
  trackMove(shifted, still(10 + TAP_MAX_MOVE_PX + 1, 10), 20)
  assert.equal(endSession(shifted, 100), null, 'сдвинулись — не тап')

  const swiped = beginSession(3, still(300, 300), 0)!
  trackMove(swiped, still(300, 400), 60)
  assert.equal(endSession(swiped, 100), null, 'жест уже сработал свайпом')
})

test('трёхпальцевый тап переживает iPadOS jitter и неодновременное отпускание', () => {
  const tap = beginSession(3, still(300, 300), 0)!
  // При реальном touchstart/touchmove Safari даёт заметнее обычного дрожание
  // центра и разлёта, хотя пользователь всё ещё не начал панорамирование.
  trackMove(
    tap,
    still(300 + TAP_MAX_MOVE_PX * 2 - 0.1, 300, 40 + TAP_MAX_SPREAD_PX * 2 - 0.1),
    120,
  )
  assert.equal(sessionStill(tap), true)
  assert.equal(endSession(tap, THREE_FINGER_TAP_MAX_MS), 'redo')

  // Окно трёх пальцев чуть длиннее общего, чтобы пережить поочерёдный
  // touchend, но всё ещё заканчивается до удержания (600 мс).
  const tooSlow = beginSession(3, still(300, 300), 0)!
  assert.equal(endSession(tooSlow, THREE_FINGER_TAP_MAX_MS + 1), null)

  // Двумя пальцами порог остаётся строгим: такой же сдвиг — уже панорама.
  const two = beginSession(2, still(300, 300), 0)!
  trackMove(two, still(300 + TAP_MAX_MOVE_PX * 2 - 0.1, 300), 120)
  assert.equal(sessionStill(two), false)
  assert.equal(endSession(two, TAP_MAX_MS), null)
})

/**
 * ⚠️ Щипок почти не двигает ЦЕНТР касаний: пальцы расходятся от него в разные
 * стороны. По одному центру мелкое приближение неотличимо от неподвижного тапа
 * двумя пальцами — доска отменяла бы действие вместо того, чтобы приблизиться.
 */
test('щипок узнаётся по разлёту пальцев, а не по центру', () => {
  const pinch = beginSession(2, still(200, 200, 40), 0)!
  trackMove(pinch, still(200, 202, 40 + TAP_MAX_SPREAD_PX + 1), 40)
  assert.equal(endSession(pinch, 120), null, 'пальцы разъехались — это щипок')
  assert.equal(trackHold(pinch, HOLD_START_MS), null, 'и удержанием он тоже не станет')

  const tap = beginSession(2, still(200, 200, 40), 0)!
  trackMove(tap, still(201, 202, 44), 40)
  assert.equal(endSession(tap, 120), 'undo', 'мелкая дрожь пальцев тап не отменяет')

  assert.deepEqual(touchShape([{ x: 0, y: 0 }, { x: 0, y: 20 }]), {
    center: { x: 0, y: 10 },
    spread: 10,
  })
  assert.equal(touchShape([]), null)
})

/**
 * ⚠️ Пальцы не уходят с экрана одновременно НИКОГДА: `touchend` приходит на
 * каждый по очереди. Пока жест забывался на первом снятом пальце, тап двумя и
 * тремя засчитывался только при невероятном совпадении — отсюда жалоба
 * 09.09.2026 «плохо срабатывает тап двумя пальцами и тремя». Ждём последнего
 * пальца, а разъезжающуюся руку с этого мига уже не слушаем.
 */
test('тап переживает то, что пальцы снимаются по очереди', () => {
  const session = beginSession(3, still(200, 200), 0)!
  beginRelease(session)
  // Оставшиеся два пальца «уехали» — это снятие руки, а не свайп.
  assert.equal(trackMove(session, still(200, 320), 60), null)
  assert.equal(endSession(session, 180), 'redo')
})

test('центр касаний считается по всем пальцам', () => {
  assert.deepEqual(touchCenter([{ x: 0, y: 0 }, { x: 10, y: 20 }]), { x: 5, y: 10 })
  assert.equal(touchCenter([]), null)
})

test('меньше двух и больше четырёх пальцев жестом не считаются', () => {
  assert.equal(beginSession(1, still(0, 0), 0), null)
  assert.equal(beginSession(5, still(0, 0), 0), null)
  assert.ok(beginSession(4, still(0, 0), 0))
})

/**
 * Сессия сохраняет максимальное число пальцев до полного отпускания,
 * но команду выполняет сразу. Живые последовательности — в tabletInteraction.
 */
test('подписка завершает тап один раз и хранит сессию до последнего пальца', () => {
  const hook = readFileSync(new URL('./useBoardFingerGestures.ts', import.meta.url), 'utf8')
  const onEnd = hook.slice(hook.indexOf('const onEnd ='), hook.indexOf('const onCancel ='))

  assert.ok(onEnd.length > 0, 'обработчик снятия пальцев должен существовать')
  assert.match(onEnd, /session\.releasing \? null : endSession\(session, Date\.now\(\)\)/u)
  assert.match(onEnd, /if \(event\.touches\.length === 0\) session = null/u)
  assert.doesNotMatch(
    onEnd,
    /if \(event\.touches\.length > 0\) \{\s*\n\s*session = null/u,
    'снятие одного пальца из трёх больше не отменяет жест',
  )
})
