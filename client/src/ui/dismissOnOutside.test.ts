// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
// @ts-expect-error Node-модуль в клиентском тесте.
import { readFileSync } from 'node:fs'

// Хук живёт на живом DOM, поэтому проверяем его ФОРМУ — приём в проекте
// прижившийся (см. modelParamContract). Важны ровно три решения, каждое из
// которых легко потерять при следующей правке.
const source = readFileSync(new URL('./dismissOnOutside.ts', import.meta.url), 'utf8')

test('слушаем pointerdown, а не click', () => {
  // При перетаскивании холста (нажал — увёл — отпустил) события click вообще
  // не будет, и оповещение висело бы до конца своего срока.
  assert.match(source, /addEventListener\('pointerdown'/)
  assert.doesNotMatch(source, /addEventListener\('click'/)
})

test('клик по самому сообщению его не гасит', () => {
  // Иначе нажатие на «Отменить» убирало бы плашку раньше, чем сработала бы
  // её собственная кнопка.
  assert.match(source, /contains\(event\.target\)\)\s*return/)
})

test('владелец может оставить открытыми связанные внешние элементы', () => {
  // Например, пин комментария живёт отдельно от карточки и сам переключает её.
  assert.match(source, /keepOpen\?\.\(event\.target\)\)\s*return/)
})

test('событие не гасится: клик мимо обязан ещё и сделать своё дело', () => {
  assert.doesNotMatch(source, /preventDefault|stopPropagation/)
})

test('слушатель снимается и не висит, пока сообщения нет', () => {
  assert.match(source, /if \(!active\) return/)
  assert.match(source, /removeEventListener\('pointerdown'/)
})
