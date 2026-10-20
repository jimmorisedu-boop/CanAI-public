// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import type { BoardHolder } from '../../../types'
import { STALE_AFTER_MS, startBoardOwnership, type BoardOwnership } from './boardOwnership'

// Правило, ради которого всё и написано: доску держит то устройство, на
// которое человек смотрит. Здесь проверяется именно оно.

function holder(clientId: string, device: string): BoardHolder {
  return { clientId, device, since: 1, lastSeen: 1 }
}

function harness(answers: Array<{ holder: BoardHolder | null; mine: boolean }>) {
  const calls: Array<{ action: string; visible: boolean }> = []
  let visible = true
  let tick: (() => void) | null = null
  let onVisibility: (() => void) | null = null
  const states: BoardOwnership[] = []
  let index = 0

  const session = startBoardOwnership('доска', (state) => states.push(state), {
    action: async (_project: string, _clientId: string, _device: string, action: string, visible = true) => {
      calls.push({ action, visible })
      const answer = answers[Math.min(index, answers.length - 1)]
      index += 1
      return answer
    },
    schedule: (callback: () => void) => {
      tick = callback
      return 1
    },
    unschedule: () => {},
    isVisible: () => visible,
    // Имя вкладки здесь ни при чём — его проверяет свой тест ниже.
    owner: () => 'me',
    subscribeVisibility: (callback: () => void) => {
      onVisibility = callback
      return () => {
        onVisibility = null
      }
    },
  })

  return {
    session,
    calls,
    states,
    setVisible(next: boolean) {
      visible = next
      onVisibility?.()
    },
    tick() {
      tick?.()
    },
  }
}

test('открытая доска занимается сразу', async () => {
  const h = harness([{ holder: holder('me', 'Windows'), mine: true }])
  await Promise.resolve()
  assert.deepEqual(h.calls.map((call) => call.action), ['heartbeat'])
  assert.equal(h.states[0]?.status, 'mine')
})

test('спрятанная вкладка перестаёт держать доску, но продолжает отмечаться', async () => {
  // Две вещи сразу. Ради первой всё и затевалось: отложил компьютер, взял
  // планшет — перехватывать ничего не надо. Вторая не менее важна: доска у
  // спрятанной вкладки ОТКРЫТА, она по-прежнему сохраняет холст, и серверная
  // доставка не должна писать под ней.
  const h = harness([{ holder: holder('me', 'Windows'), mine: true }])
  await Promise.resolve()
  h.setVisible(false)
  await Promise.resolve()
  h.tick()
  await Promise.resolve()
  assert.deepEqual(h.calls.map((call) => call.action), ['heartbeat', 'heartbeat', 'heartbeat'])
  assert.deepEqual(h.calls.map((call) => call.visible), [true, false, false])
})

test('уходя, клиент отпускает доску даже если не держал её', async () => {
  // Иначе сервер считал бы доску открытой ещё три минуты после закрытия
  // вкладки — и всё это время не ставил бы на неё результаты.
  const h = harness([{ holder: holder('other', 'iPad'), mine: false }])
  await Promise.resolve()
  h.session.stop()
  await Promise.resolve()
  assert.equal(h.calls.at(-1)?.action, 'release')
})

test('чужое владение доезжает до подписчика ровно один раз', async () => {
  const h = harness([{ holder: holder('ipad', 'iPad'), mine: false }])
  await Promise.resolve()
  h.tick()
  await Promise.resolve()
  h.tick()
  await Promise.resolve()
  assert.deepEqual(h.states.map((state) => state.status), ['other'])
})

test('сетевая ошибка не выбивает из-за руля', async () => {
  // Уводить человека в режим просмотра из-за моргнувшей сети — худшее, что
  // тут можно сделать: работа продолжается, а сохранять её уже некому.
  const states: BoardOwnership[] = []
  let calls = 0
  const session = startBoardOwnership('доска', (state) => states.push(state), {
    action: async () => {
      calls += 1
      if (calls === 1) return { holder: holder('me', 'Windows'), mine: true }
      throw new Error('сеть недоступна')
    },
    schedule: () => 1,
    unschedule: () => {},
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    owner: () => 'me',
  })
  await Promise.resolve()
  await session.ping().catch(() => {})
  assert.deepEqual(states.map((state) => state.status), ['mine'])
  session.stop()
})

test('перехват возвращает доску себе', async () => {
  const h = harness([
    { holder: holder('ipad', 'iPad'), mine: false },
    { holder: holder('me', 'Windows'), mine: true },
  ])
  await Promise.resolve()
  const after = await h.session.claim()
  assert.equal(after.status, 'mine')
  assert.equal(h.calls.at(-1)?.action, 'claim')
})

test('проспавший клиент узнаёт, что его снимок устарел', async () => {
  // Ноутбук уснул, вкладку заморозили — сервер за это время посчитал доску
  // ничьей и мог сам поставить на неё результат. Дописывать доску по памяти
  // после такого нельзя: там уже не то, что мы помним.
  let clock = 1000
  const states: BoardOwnership[] = []
  let tick: (() => void) | null = null
  startBoardOwnership('доска', (state) => states.push(state), {
    action: async () => ({ holder: holder('me', 'Windows'), mine: true }),
    schedule: (callback: () => void) => {
      tick = callback
      return 1
    },
    unschedule: () => {},
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    now: () => clock,
    owner: () => 'me',
  })
  await Promise.resolve()
  clock += STALE_AFTER_MS + 1
  tick?.()
  await Promise.resolve()
  assert.equal(states.at(-1)?.status, 'stale')
})

test('вторая вкладка не выдаётся за другое устройство', async () => {
  const { boardHandoffTitle } = await import('./BoardHandoffState')
  // Сказать «доска на устройстве Windows» человеку, который сидит за этим же
  // Windows, значит отправить его искать несуществующий второй компьютер.
  assert.equal(boardHandoffTitle('Windows', true), 'Board is open in another tab')
  assert.match(boardHandoffTitle('iPad', false), /device “iPad”/)
})

test('отмечается под ПРОВЕРЕННЫМ именем вкладки и не раньше', async () => {
  // Вкладка, открытая из этой, получает копию sessionStorage — а с ним и чужое
  // имя. Отметка под ним и делала две вкладки одним держателем доски.
  let resolveOwner: (id: string) => void = () => {}
  const owner = new Promise<string>((resolve) => {
    resolveOwner = resolve
  })
  const seen: string[] = []
  const session = startBoardOwnership('доска', () => {}, {
    action: async (_project: string, clientId: string) => {
      seen.push(clientId)
      return { holder: holder(clientId, 'Windows'), mine: true }
    },
    schedule: () => 1,
    unschedule: () => {},
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    owner: () => owner,
  })
  await Promise.resolve()
  assert.deepEqual(seen, [], 'до проверки имени отмечаться нельзя')
  resolveOwner('устройство~проверенная-вкладка')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(seen, ['устройство~проверенная-вкладка'])
  session.stop()
})
