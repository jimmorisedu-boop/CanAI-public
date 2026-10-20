import test from 'node:test'
import assert from 'node:assert/strict'
import {
  closeCompare,
  confirmComparePicking,
  getCompareSession,
  openCompareViewer,
  setCompareCandidates,
  startComparePicking,
  toggleCompareCandidate,
} from './compareBus'

test('набор начинается с исходника и пустого списка кандидатов', () => {
  closeCompare()
  startComparePicking('src')
  const session = getCompareSession()
  assert.equal(session?.phase, 'picking')
  assert.equal(session?.baselineId, 'src')
  assert.deepEqual(session?.candidateIds, [])
  closeCompare()
})

test('клик добавляет, повторный клик убирает, порядок сохраняется', () => {
  closeCompare()
  startComparePicking('src')
  toggleCompareCandidate('b')
  toggleCompareCandidate('a')
  assert.deepEqual(getCompareSession()?.candidateIds, ['b', 'a'])

  toggleCompareCandidate('b')
  assert.deepEqual(getCompareSession()?.candidateIds, ['a'])
  closeCompare()
})

test('исходник нельзя добавить кандидатом к самому себе', () => {
  closeCompare()
  startComparePicking('src')
  toggleCompareCandidate('src')
  assert.deepEqual(getCompareSession()?.candidateIds, [])
  closeCompare()
})

test('«взять все генерации» не втягивает исходник', () => {
  closeCompare()
  startComparePicking('src')
  setCompareCandidates(['a', 'src', 'b'])
  assert.deepEqual(getCompareSession()?.candidateIds, ['a', 'b'])
  closeCompare()
})

test('пустой набор не открывает просмотрщик', () => {
  closeCompare()
  startComparePicking('src')
  confirmComparePicking()
  assert.equal(getCompareSession()?.phase, 'picking')

  openCompareViewer('src', [])
  assert.equal(getCompareSession()?.phase, 'picking')
  closeCompare()
})

test('подтверждение переводит набор в просмотр, сохраняя порядок', () => {
  closeCompare()
  startComparePicking('src')
  toggleCompareCandidate('a')
  toggleCompareCandidate('b')
  confirmComparePicking()

  const session = getCompareSession()
  assert.equal(session?.phase, 'viewing')
  assert.equal(session?.baselineId, 'src')
  assert.deepEqual(session?.candidateIds, ['a', 'b'])
  closeCompare()
})

test('в фазе просмотра набор больше не меняется', () => {
  closeCompare()
  openCompareViewer('src', ['a'], true)
  toggleCompareCandidate('b')
  setCompareCandidates(['x', 'y'])
  const session = getCompareSession()
  assert.deepEqual(session?.candidateIds, ['a'])
  assert.equal(session?.phase === 'viewing' && session.pulledIn, true)
  closeCompare()
})

test('закрытие обнуляет сессию', () => {
  startComparePicking('src')
  closeCompare()
  assert.equal(getCompareSession(), null)
})
