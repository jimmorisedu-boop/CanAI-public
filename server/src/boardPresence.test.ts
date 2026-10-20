import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOARD_ATTACH_TTL_MS,
  BOARD_HOLD_TTL_MS,
  boardAttached,
  boardBusy,
  boardHolder,
  claimBoard,
  heartbeatBoard,
  listBoardHolders,
  releaseBoard,
  resetBoardPresence,
  PRESENCE_WARMUP_MS,
  presenceWarmingUp,
  startPresenceWarmup,
} from './boardPresence.js'

const WIN = 'client-windows-1'
const PAD = 'client-ipad-1'

test('свободную доску heartbeat занимает сам', () => {
  resetBoardPresence()
  const answer = heartbeatBoard('доска', WIN, 'Windows', 1000)
  assert.equal(answer.mine, true)
  assert.equal(answer.holder?.device, 'Windows')
})

test('чужую доску heartbeat НЕ отбирает', () => {
  // Иначе два открытых устройства перетягивали бы владение друг у друга на
  // каждом тике, и оба считали бы себя за рулём.
  resetBoardPresence()
  heartbeatBoard('доска', WIN, 'Windows', 1000)
  const answer = heartbeatBoard('доска', PAD, 'iPad', 1500)
  assert.equal(answer.mine, false)
  assert.equal(answer.holder?.clientId, WIN)
})

test('перехват передаёт доску, и прежний держатель узнаёт об этом', () => {
  resetBoardPresence()
  heartbeatBoard('доска', WIN, 'Windows', 1000)
  const taken = claimBoard('доска', PAD, 'iPad', 2000)
  assert.equal(taken.mine, true)
  assert.equal(taken.holder?.clientId, PAD)
  // Ровно этот ответ и переводит компьютер в режим просмотра.
  assert.equal(heartbeatBoard('доска', WIN, 'Windows', 2100).mine, false)
})

test('держатель протухает без heartbeat', () => {
  // Планшет уснул или вкладку закрыли без release — доска обязана
  // освободиться сама, иначе она останется занятой навсегда.
  resetBoardPresence()
  heartbeatBoard('доска', PAD, 'iPad', 1000)
  assert.equal(boardHolder('доска', 1000 + BOARD_HOLD_TTL_MS)?.clientId, PAD)
  assert.equal(boardHolder('доска', 1000 + BOARD_HOLD_TTL_MS + 1), null)
  assert.equal(heartbeatBoard('доска', WIN, 'Windows', 1000 + BOARD_HOLD_TTL_MS + 2).mine, true)
})

test('release не отбирает доску у того, кто уже перехватил', () => {
  // Закрывающаяся вкладка шлёт release с опозданием; если он снимет чужое
  // владение, планшет молча окажется без руля.
  resetBoardPresence()
  heartbeatBoard('доска', WIN, 'Windows', 1000)
  claimBoard('доска', PAD, 'iPad', 2000)
  const answer = releaseBoard('доска', WIN, 2100)
  assert.equal(answer.holder?.clientId, PAD)
  assert.equal(boardHolder('доска', 2200)?.clientId, PAD)
})

test('свой release освобождает доску', () => {
  resetBoardPresence()
  heartbeatBoard('доска', WIN, 'Windows', 1000)
  releaseBoard('доска', WIN, 1500)
  assert.equal(boardHolder('доска', 1600), null)
})

test('время начала владения не сбрасывается на каждом тике', () => {
  // «Открыта на iPad 40 минут» считается от since — если бы он обновлялся
  // вместе с lastSeen, там всегда была бы секунда.
  resetBoardPresence()
  heartbeatBoard('доска', PAD, 'iPad', 1000)
  heartbeatBoard('доска', PAD, 'iPad', 9000)
  assert.equal(boardHolder('доска', 9000)?.since, 1000)
})

test('список для галереи показывает только живых держателей', () => {
  resetBoardPresence()
  heartbeatBoard('первая', WIN, 'Windows', 1000)
  heartbeatBoard('вторая', PAD, 'iPad', 1000)
  const now = 1000 + BOARD_HOLD_TTL_MS + 1
  heartbeatBoard('вторая', PAD, 'iPad', now)
  const live = listBoardHolders(now)
  assert.deepEqual(live.map((entry) => entry.projectId), ['вторая'])
})

test('спрятанная вкладка перестаёт держать доску, но доска остаётся ОТКРЫТОЙ', () => {
  // Разделение, ради которого заведён второй срок: держателем свёрнутая
  // вкладка быть не должна (иначе планшету пришлось бы перехватывать), но
  // холст она по-прежнему сохраняет — и серверная доставка не имеет права
  // писать под ней.
  resetBoardPresence()
  heartbeatBoard('доска', WIN, 'Windows', 1000)
  const hidden = heartbeatBoard('доска', WIN, 'Windows', 2000, false)
  assert.equal(hidden.mine, false)
  assert.equal(boardHolder('доска', 2000), null)
  assert.equal(boardAttached('доска', 2000), true)
  assert.equal(boardBusy('доска', 2000), true)
})

test('свободной доска считается только когда её никто не открыл', () => {
  resetBoardPresence()
  assert.equal(boardBusy('доска', 1000), false)
  heartbeatBoard('доска', PAD, 'iPad', 1000, false)
  assert.equal(boardBusy('доска', 1000), true)
  // Закрыли вкладку — доска сразу ничья, ждать три минуты незачем.
  releaseBoard('доска', PAD, 1200)
  assert.equal(boardBusy('доска', 1200), false)
})

test('открытость протухает сама, если вкладка перестала отмечаться', () => {
  resetBoardPresence()
  heartbeatBoard('доска', PAD, 'iPad', 1000, false)
  assert.equal(boardBusy('доска', 1000 + BOARD_ATTACH_TTL_MS), true)
  assert.equal(boardBusy('доска', 1000 + BOARD_ATTACH_TTL_MS + 1), false)
})

test('сразу после запуска сервер не считает ни одну доску свободной', () => {
  // Присутствие живёт в памяти и после перезапуска пусто, а вкладки, пережившие
  // перезапуск, отметятся не сразу — спрятанная не чаще раза в минуту. Результат,
  // поставленный сервером в этот миг, лёг бы под открытую доску, и её следующее
  // сохранение ушло бы в конфликтную копию.
  resetBoardPresence()
  startPresenceWarmup(1000)
  assert.equal(presenceWarmingUp(1000 + 60_000), true, 'минуты мало: спрятанная вкладка отмечается раз в минуту')
  assert.equal(presenceWarmingUp(1000 + PRESENCE_WARMUP_MS), false)
  resetBoardPresence()
  assert.equal(presenceWarmingUp(1000), false, 'сброс для тестов снимает и паузу')
})
