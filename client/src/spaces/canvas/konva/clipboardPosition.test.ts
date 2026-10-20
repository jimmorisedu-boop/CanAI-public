import assert from 'node:assert/strict'
import test from 'node:test'

const storageMap = new Map<string, string>()
const mockLocalStorage = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, val: string) => storageMap.set(key, val),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
  key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
  get length() {
    return storageMap.size
  },
}

Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
  configurable: true,
})

import { CanvasStore } from './canvasStore.js'
import {
  copySelected,
  hasClipboard,
  paste,
  syncInternalClipboardFromSystem,
  clipboardMirrorFailed,
} from './clipboard.js'
import { OWN_CLIPBOARD_TYPE } from './pasteDecision.js'
import type { CanvasItem } from './types.js'

test('вставка скопированных элементов помещает группу к координатам курсора', async () => {
  storageMap.clear()
  const store1 = new CanvasStore()
  store1.placeText('A', { x: 100, y: 200 })
  store1.placeText('B', { x: 300, y: 400 })
  const ids = store1.getItems().map((i) => i.id)
  store1.setSelection(ids)

  copySelected(store1)

  // Вставляем на другую доску в точку курсора (1500, 2500).
  const store2 = new CanvasStore()
  // ⚠️ Вставка асинхронна: на сетевой доске она сперва переселяет файлы
  // на сервер команды (см. pasteAdoption.ts). Здесь доска локальная и
  // переселять нечего, но ждать ответа всё равно надо.
  await paste(store2, { x: 1500, y: 2500 })

  const items = store2.getItems()
  assert.equal(items.length, 2)

  // Исходная группа имела minX=100, minY=200, относительное смещение item2 было (+200, +200).
  const first = items.find((i) => (i as CanvasItem).text === 'A')
  const second = items.find((i) => (i as CanvasItem).text === 'B')
  assert.ok(first)
  assert.ok(second)

  assert.equal(first.x, 1500)
  assert.equal(first.y, 2500)
  assert.equal(second.x, 1700)
  assert.equal(second.y, 2700)
})

test('вставка без указания точки помещает группу по центру вьюпорта', async () => {
  storageMap.clear()
  const store = new CanvasStore()
  store.placeText('Card', { x: 0, y: 0 })
  store.setSelection([store.getItems()[0].id])
  copySelected(store)

  const storeNew = new CanvasStore()
  // Камера x=0, y=0, scale=1, вьюпорт 1000x800. Центр (500, 400).
  await paste(storeNew, undefined, { w: 1000, h: 800 })

  const pasted = storeNew.getItems()[0]
  assert.ok(pasted)
  // Вставка по центру вьюпорта (500, 400):
  // destX = 500 - pasted.w / 2
  // destY = 400 - pasted.h / 2
  assert.equal(pasted.x, 500 - Math.round(pasted.w / 2))
  assert.equal(pasted.y, 400 - Math.round(pasted.h / 2))
})

test('нативное событие copy синхронно получает маркер объектов холста', () => {
  storageMap.clear()
  const source = new CanvasStore()
  source.placeText('Для другой доски', { x: 0, y: 0 })
  source.setSelection([source.getItems()[0].id])
  let systemText = ''

  copySelected(source, {
    setData(type, value) {
      assert.equal(type, 'text/plain')
      systemText = value
    },
  })

  assert.equal(JSON.parse(systemText).type, OWN_CLIPBOARD_TYPE)
  assert.equal(clipboardMirrorFailed(), false, 'запись прошла — помечать нечего')
})

test('собственный системный маркер восстанавливает объекты после перехода на другую страницу', async () => {
  storageMap.clear()
  const source = new CanvasStore()
  source.placeText('Между досками', { x: 10, y: 20 })
  source.setSelection([source.getItems()[0].id])
  let systemText = ''
  copySelected(source, { setData: (_type, value) => { systemText = value } })

  storageMap.clear()
  assert.equal(hasClipboard(), false)
  assert.equal(syncInternalClipboardFromSystem(systemText), true)

  const target = new CanvasStore()
  await paste(target, { x: 500, y: 600 })
  assert.equal(target.getItems().length, 1)
  assert.equal(target.getItems()[0].text, 'Между досками')
  assert.equal(target.getItems()[0].x, 500)
  assert.equal(target.getItems()[0].y, 600)
})

test('Ctrl+C картинки кладёт метку сразу, а картинку следом — и ничего после неё', async () => {
  storageMap.clear()
  const source = new CanvasStore()
  const id = source.addItem({
    kind: 'image', x: 0, y: 0, w: 320, h: 180, src: '/media/photo.png',
  })
  source.setSelection([id])
  const imageWrites: string[] = []
  const eventWrites: string[] = []
  const textWrites: string[] = []

  copySelected(source, {
    setData: (_type, value) => { eventWrites.push(value) },
  }, {
    copyImage: async (_item, payload) => {
      imageWrites.push(payload)
      return true
    },
    writeText: async (payload) => { textWrites.push(payload) },
  })
  // ⚠️ Метка уже в буфере — до того, как картинка скачана. Раньше ждали одну
  // картинку, и быстрый Ctrl+V вставлял то, что лежало в буфере до копирования.
  assert.equal(eventWrites.length, 1, 'метка легла сразу, в самом событии copy')
  assert.equal(JSON.parse(eventWrites[0]!).type, OWN_CLIPBOARD_TYPE)
  assert.equal(clipboardMirrorFailed(), false)
  await Promise.resolve()

  assert.equal(imageWrites.length, 1)
  assert.equal(JSON.parse(imageWrites[0]!).type, OWN_CLIPBOARD_TYPE)
  assert.deepEqual(textWrites, [], 'writeText ПОСЛЕ картинки затёр бы PNG')
})

test('копия картинки без события copy: пока метка не легла, файл из буфера не побеждает', async () => {
  storageMap.clear()
  const source = new CanvasStore()
  const id = source.addItem({ kind: 'image', x: 0, y: 0, w: 320, h: 180, src: '/media/photo.png' })
  source.setSelection([id])
  let releaseText: () => void = () => {}
  let waited: Promise<unknown> | undefined

  // Контекстное меню и Ctrl+X: события copy нет, метка идёт через writeText.
  copySelected(source, undefined, {
    writeText: () => new Promise<void>((resolve) => { releaseText = resolve }),
    copyImage: async (_item, _payload, options) => {
      waited = options?.after
      await options?.after
      throw new Error('браузер отказал')
    },
  })
  assert.equal(clipboardMirrorFailed(), true, 'метка ещё в пути — в буфере пока чужое')
  assert.ok(waited, 'картинка ждёт метку: придя первой, она была бы перетёрта текстом')

  releaseText()
  await waited
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(clipboardMirrorFailed(), false, 'метка легла — отказ картинки вставке уже не мешает')
})

test('поздний ответ старой записи не путает отметку о провале', async () => {
  // Помним именно ПРОВАЛ записи в системный буфер, поэтому проверять надо его:
  // отказ старой попытки не должен пометить свежую копию, которая прошла, и
  // наоборот — своя неудача обязана отметиться.
  storageMap.clear()
  const pending: Array<{ ok: () => void; fail: () => void }> = []
  let defer = false
  const write = () => defer
    ? new Promise<void>((resolve, reject) => { pending.push({ ok: resolve, fail: () => reject(new Error('нет прав')) }) })
    : Promise.resolve()
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: () => write() } },
    configurable: true,
  })

  const source = new CanvasStore()
  source.placeText('Первая копия', { x: 0, y: 0 })
  source.setSelection([source.getItems()[0].id])
  defer = true
  copySelected(source)

  source.placeText('Свежая копия', { x: 200, y: 0 })
  source.setSelection([source.getItems()[1].id])
  defer = false
  copySelected(source)
  await Promise.resolve()
  assert.equal(clipboardMirrorFailed(), false, 'свежая копия записалась')

  pending[0]?.fail()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(clipboardMirrorFailed(), false, 'отказ ПРОШЛОЙ попытки к свежей копии не относится')

  source.placeText('Третья копия', { x: 400, y: 0 })
  source.setSelection([source.getItems()[2].id])
  defer = true
  copySelected(source)
  pending[1]?.fail()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(clipboardMirrorFailed(), true, 'своя неудача отмечается')
})
