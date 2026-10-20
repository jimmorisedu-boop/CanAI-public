// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readFileSync } from 'node:fs'
import { readAllStyles } from '../testStyles'

// Решение пользователя 19.08.2026: «сделаем дизайн для оповещений, они должны
// быть одинаковые» и «всё в одном углу». Одинаковыми они остаются ровно до
// первой правки, сделанной не там: до этого материал объявляла каждая
// поверхность сама, в четырёх файлах, и они разъехались молча — чип пилюлей с
// мягкой тенью, карточка внешней правки крупным скруглением с сильной,
// всплывашка третьим сочетанием. Отсюда сторож.

const SURFACES = ['.global-toast', '.inline-notice', '.external-edit-status-card', '.operation-state']
const notices = readFileSync(new URL('../styles/notices.css', import.meta.url), 'utf8')

test('материал объявлен один раз и перечисляет ВСЕ поверхности сообщений', () => {
  const block = notices.match(/\/\* Материал\. Один на все виды сообщений\. \*\/([\s\S]*?)\}/)
  assert.ok(block, 'в notices.css должен быть блок общего материала')
  for (const surface of SURFACES) {
    assert.ok(block[1].includes(surface), `${surface} должен брать общий материал`)
  }
  for (const property of ['border:', 'border-radius:', 'background:', 'color:', 'font-size:']) {
    assert.ok(block[1].includes(property), `материал обязан задавать ${property}`)
  }
})

test('никто не объявляет свой материал в обход общего', () => {
  // Сам общий блок из проверки вычитаем: он и есть единственное разрешённое
  // место, а заканчивается обычным селектором и иначе ловил бы сам себя.
  const styles = readAllStyles().replace(
    /\/\* Материал\. Один на все виды сообщений\. \*\/[\s\S]*?\}/,
    '',
  )
  for (const surface of SURFACES) {
    // Правило поверхности вида «.global-toast { … background: … }» вне общего
    // блока — это и есть начало расползания.
    const own = new RegExp(`\\${surface} \\{[^}]*background:`, 'g')
    const matches = styles.match(own) ?? []
    assert.equal(
      matches.length,
      0,
      `${surface} задаёт свой фон — материал берётся из общего блока в notices.css`,
    )
  }
})

test('всплывающие сообщения приходят из ОДНОГО угла', () => {
  // Раньше внешние правки жили в правом верхнем углу, всплывашки в нижнем, а
  // часть висела полоской над промпт-баром.
  assert.match(notices, /\.notice-corner \{[\s\S]*?position: fixed;[\s\S]*?bottom: 18px;/)
  const styles = readAllStyles()
  assert.doesNotMatch(
    styles,
    /\.external-edit-status-host \{[^}]*position: fixed/,
    'у сообщений о правках не должно быть своего угла',
  )
})

test('тон — точкой, а не заливкой во всю плашку', () => {
  // Заливка тоном во всю ширину — ровно тот «баннер», от которого уходили.
  assert.doesNotMatch(notices, /background: var\(--danger-soft\)/)
  assert.match(notices, /border-color: color-mix\(in srgb, var\(--danger\) 30%, var\(--border\)\)/)
})

test('над холстом сообщений о внешних правках больше нет', () => {
  const promptNotices = readFileSync(
    new URL('../spaces/canvas/PromptNotices.tsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(promptNotices, /useEditNotices|PublicEditSession|job-chips/)
})
