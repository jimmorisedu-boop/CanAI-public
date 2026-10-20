import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { removeComposerReference } from './referenceComposer.js'
import type { SelectionRef } from './konva/selection'

const media = (shapeId: string, src: string): SelectionRef =>
  ({ shapeId, kind: 'image', src, label: src } as SelectionRef)

/**
 * ⚠️ Приложение правит написанное человеком РОВНО В ОДНОМ месте — когда он сам
 * снял чип референса. Жалоба 08.09.2026: на сетевой доске промпт «сделай фото
 * @1 в профиль, нос возьми от сюда @2» ушёл в оплаченную генерацию как «сделай
 * фото в профиль, нос возьми от сюда @1» — то есть первая ссылка исчезла, а
 * вторая заняла её место. Переписывал текст эффект, следивший за СОСТАВОМ
 * референсов; но состав зеркалит выделение канваса, а оно пропадает и без воли
 * человека: сетевая доска перечитывает снимок при каждом переподключении
 * (store.loadDoc сбрасывает выделение), клик по пустому месту снимает всё. Чипы
 * при этом возвращаются, и понять со стороны, что случилось с текстом, нельзя.
 */
test('снятый человеком чип уносит свою ссылку и сдвигает следующие', () => {
  const refs = [media('a', '/media/1.png'), media('b', '/media/2.png')]
  const text = 'сделай фото @1 в профиль, нос возьми от сюда @2'

  assert.equal(
    removeComposerReference(refs, text, 'a').text,
    'сделай фото в профиль, нос возьми от сюда @1',
  )
  assert.equal(
    removeComposerReference(refs, text, 'b').text,
    'сделай фото @1 в профиль, нос возьми от сюда',
  )
})

test('перенумерация живёт только в removeRef и ни в каком эффекте', async () => {
  const source = await readFile(new URL('./PromptBar.tsx', import.meta.url), 'utf8')
  const calls = source.match(/removeComposerReference\(/g) ?? []
  assert.equal(calls.length, 1, 'единственная точка правки чужого текста')

  const removeRef = source.slice(source.indexOf('function removeRef('))
  const body = removeRef.slice(0, removeRef.indexOf('\n  }'))
  assert.match(body, /removeComposerReference\(/, 'правит именно снятие чипа')

  // Эффекта, который переписывал бы промпт по составу референсов, быть не
  // должно: он и был причиной жалобы.
  assert.doesNotMatch(source, /removedMediaReferences/)
  assert.doesNotMatch(source, /previousRefsRef/)
})
