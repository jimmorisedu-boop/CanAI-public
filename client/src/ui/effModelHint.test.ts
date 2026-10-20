// @ts-expect-error Client production build does not depend on Node typings.
import assert from 'node:assert/strict'
// @ts-expect-error Client production build does not depend on Node typings.
import test from 'node:test'

import { effModelSuffix, effModelTitle } from './effModelHint'

test('из имени варианта остаётся только отличие от базовой модели', () => {
  assert.equal(effModelSuffix('Seedream 5.0 Pro', 'Seedream 5.0 Pro — по референсам'), 'по референсам')
  assert.equal(
    effModelSuffix('ByteDance Seedance 2.0', 'ByteDance Seedance 2.0 — первый/последний кадр'),
    'первый/последний кадр',
  )
})

test('имя, названное не по общему правилу, показывается целиком', () => {
  // У части моделей вариант назван без разделителя — обрезать там нечего,
  // и огрызок был бы хуже полного имени.
  assert.equal(effModelSuffix('Grok Image', 'Grok Image Edit'), 'Grok Image Edit')
  assert.equal(effModelSuffix('Grok Video', 'Grok Video Edit'), 'Grok Video Edit')
})

test('совпадение имён и пустой хвост не превращаются в пустую подсказку', () => {
  // Пустая подсказка выглядела бы как поломка: «включена «»».
  assert.equal(effModelSuffix('Nano Banana 2', 'Nano Banana 2'), 'Nano Banana 2')
  assert.equal(effModelSuffix('Nano Banana 2', 'Nano Banana 2 —   '), 'Nano Banana 2 —   ')
})

test('полное имя не теряется — оно уходит в подсказку при наведении', () => {
  assert.equal(
    effModelTitle('Включилась по референсу — как в нодах', 'Seedream 5.0 Pro — по референсам'),
    'Включилась по референсу — как в нодах: Seedream 5.0 Pro — по референсам',
  )
})
