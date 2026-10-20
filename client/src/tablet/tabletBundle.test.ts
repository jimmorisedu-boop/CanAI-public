import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Сторож по СОБРАННОЙ странице, а не по исходникам.
//
// Сторож в `tabletShell.test.ts` обходит `client/src` и не пускает туда
// прямые вызовы `crypto.randomUUID` и `navigator.clipboard`. Но он не видит
// ЗАВИСИМОСТЕЙ: если завтра библиотека внутри позовёт randomUUID, планшет
// снова встретит человека белым экраном, а сторож промолчит.
//
// Планшет живёт по адресу вида http://192.168.1.5:8789 — это не защищённый
// контекст, и таких API там нет вовсе (замерено вживую: isSecureContext
// false, randomUUID undefined, clipboard undefined). Поэтому проверяем то,
// что реально уезжает на устройство.

const DIST = new URL('../../dist/tablet/assets/', import.meta.url).pathname
const TABLET_MAIN = new URL('./main.tsx', import.meta.url)
const MODAL_CSS = new URL('../styles/modal.css', import.meta.url)

/** Вызов законен, если рядом стоит проверка наличия. */
function unguarded(source: string, needle: string): boolean {
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at === -1) return false
    // Окно вокруг вызова: минифицированный код держит проверку вплотную
    // («typeof n?.randomUUID=="function"», «(r=navigator.clipboard)!=null&&»).
    const around = source.slice(Math.max(0, at - 160), at + needle.length)
    if (!/typeof|!=null|!==\s*(?:void 0|undefined)|&&|\?\./.test(around)) return true
    from = at + needle.length
  }
}

test('в собранной странице планшета нет незащищённых вызовов crypto.randomUUID и clipboard', () => {
  if (!existsSync(DIST)) {
    // Сборки нет — проверять нечего. Лаунчер и поставка собирают её сами,
    // и падать на чистой копии репозитория этот тест не должен.
    return
  }
  const offenders: string[] = []
  for (const name of readdirSync(DIST)) {
    if (!name.endsWith('.js')) continue
    const source = readFileSync(join(DIST, name), 'utf8')
    if (unguarded(source, '.randomUUID(')) offenders.push(`${name}: crypto.randomUUID без проверки`)
    if (unguarded(source, 'navigator.clipboard.')) offenders.push(`${name}: navigator.clipboard без проверки`)
    // crypto.subtle вне защищённого контекста отсутствует целиком, и запасного
    // пути у него нет — на планшете ему делать нечего.
    if (source.includes('crypto.subtle')) offenders.push(`${name}: crypto.subtle недоступен на планшете`)
  }
  assert.deepEqual(offenders, [], `в планшетной сборке:\n${offenders.join('\n')}`)
})

test('планшет подключает общие стили модальных окон', () => {
  const main = readFileSync(TABLET_MAIN, 'utf8')
  const modal = readFileSync(MODAL_CSS, 'utf8')

  assert.match(main, /import ['"]\.\.\/styles\/modal\.css['"]/, 'tablet main должен импортировать modal.css')
  assert.match(modal, /\.modal-backdrop\s*\{[\s\S]*position:\s*fixed;/, 'подложка модалки должна быть fixed')
  assert.match(modal, /\.modal-card\s*\{[\s\S]*background:/, 'карточка модалки должна иметь фон')
  assert.match(modal, /\.confirm-dialog\s*\{[\s\S]*width:/, 'диалог подтверждения должен иметь геометрию')
  assert.match(modal, /\.confirm-actions\s*\{[\s\S]*display:\s*flex;/, 'действия подтверждения должны быть оформлены')
})
