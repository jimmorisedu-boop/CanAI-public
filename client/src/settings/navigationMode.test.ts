// @ts-expect-error Тест запускается с серверным tsx и Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается с серверным tsx и Node-типами.
import test from 'node:test'
import {
  createNavigationModeStore,
  reactFlowNavigationProps,
  resolveNavigationModeStorage,
} from './navigationMode.js'

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}))
  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}

test('режим мыши остаётся поведением по умолчанию', () => {
  const store = createNavigationModeStore(memoryStorage())

  assert.equal(store.getSnapshot(), 'mouse')
})

test('сохранённый режим тачпада восстанавливается на этом устройстве', () => {
  const storage = memoryStorage({ 'canai-navigation-mode': 'touchpad' })
  const store = createNavigationModeStore(storage)

  assert.equal(store.getSnapshot(), 'touchpad')
})

test('смена режима сохраняется и сразу сообщает подписчикам', () => {
  const storage = memoryStorage()
  const store = createNavigationModeStore(storage)
  let notifications = 0
  store.subscribe(() => { notifications += 1 })

  store.set('touchpad')

  assert.equal(store.getSnapshot(), 'touchpad')
  assert.equal(storage.getItem('canai-navigation-mode'), 'touchpad')
  assert.equal(notifications, 1)
})

test('неизвестное сохранённое значение безопасно возвращает режим мыши', () => {
  const store = createNavigationModeStore(memoryStorage({ 'canai-navigation-mode': 'other' }))

  assert.equal(store.getSnapshot(), 'mouse')
})

test('запрещённый браузером localStorage не роняет загрузку приложения', () => {
  const browser = Object.defineProperty({}, 'localStorage', {
    get() {
      throw new DOMException('Blocked', 'SecurityError')
    },
  })

  assert.equal(resolveNavigationModeStorage(browser), null)
})

test('режим навигации однозначно задаёт wheel props редактора нод', () => {
  assert.deepEqual(reactFlowNavigationProps('mouse'), {
    zoomOnScroll: true,
    zoomOnPinch: true,
    panOnScroll: false,
  })
  assert.deepEqual(reactFlowNavigationProps('touchpad'), {
    zoomOnScroll: false,
    zoomOnPinch: true,
    panOnScroll: true,
  })
})
