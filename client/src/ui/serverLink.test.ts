// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import {
  getServerLink,
  linkFromAccount,
  linkFromBoardState,
  publishAccountServerLink,
  publishBoardServerLink,
  resetServerLink,
  subscribeServerLink,
} from './serverLink.js'

test('не в команде — точки нет вовсе', () => {
  // Показывать «нет связи» тому, кому не с чем связываться, значит пугать
  // поломкой, которой не существует.
  assert.equal(linkFromAccount({ connected: false, reachable: false }), 'unknown')
  assert.equal(linkFromAccount({ connected: true, reachable: true }), 'online')
  assert.equal(linkFromAccount({ connected: true, reachable: false }), 'offline')
})

test('открытие доски — ещё не диагноз', () => {
  // `connecting` идёт в два шага, и в промежутке связи формально нет; красная
  // точка на каждом открытии моргала бы тревогой на ровном месте.
  assert.equal(linkFromBoardState('connecting'), 'unknown')
  assert.equal(linkFromBoardState('ready'), 'online')
  assert.equal(linkFromBoardState('readonly'), 'online')
  assert.equal(linkFromBoardState('offline'), 'offline')
  assert.equal(linkFromBoardState('error'), 'offline')
})

test('живая доска перевешивает профиль — она узнаёт об обрыве первой', () => {
  resetServerLink()
  publishAccountServerLink('online')
  assert.equal(getServerLink(), 'online')
  publishBoardServerLink('offline')
  assert.equal(getServerLink(), 'offline', 'доска знает точнее минутного опроса профиля')
  // Доску закрыли — правду снова знает только профиль.
  publishBoardServerLink('unknown')
  assert.equal(getServerLink(), 'online')
  resetServerLink()
})

test('подписчику сообщают только о настоящих изменениях', () => {
  resetServerLink()
  let calls = 0
  const off = subscribeServerLink(() => { calls++ })
  publishAccountServerLink('online')
  publishAccountServerLink('online')
  assert.equal(calls, 1, 'то же значение подписчиков не будит')
  off()
  resetServerLink()
})
