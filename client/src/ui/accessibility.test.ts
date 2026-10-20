// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import path from 'node:path'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { fileURLToPath } from 'node:url'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { readAllStyles } from '../testStyles'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')

function sources(): Array<{ where: string; text: string }> {
  const found: Array<{ where: string; text: string }> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) continue
      found.push({ where: path.relative(ROOT, full), text: readFileSync(full, 'utf8') })
    }
  }
  walk(ROOT)
  return found
}

const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

// Плейсхолдер исчезает с первой буквой, поэтому подписью он быть не может.
// Правило общее: у поля ввода есть имя, которое диктор произносит всегда.
test('у каждого поля ввода есть постоянная подпись, а не только плейсхолдер', () => {
  const nameless: string[] = []
  for (const { where, text } of sources()) {
    for (const tag of text.match(/<textarea[\s\S]*?\/?>/g) ?? []) {
      if (!/aria-label(?:ledby)?[={]/.test(tag)) nameless.push(where)
    }
  }
  assert.deepEqual(nameless, [], `поля без подписи: ${nameless.join(', ')}`)
})

// role="tab" обещает диктору панель. Если панели нет, обещание ложное — и
// пользователь ищет содержимое, которого не существует. Именно этим и был
// переключатель «Промпт ↔ Помощник»: поле ввода у обоих окон общее.
test('вкладка без панели не заводится', () => {
  const broken: string[] = []
  for (const { where, text } of sources()) {
    for (const tag of text.match(/<[A-Za-z][^>]*role="tab"[\s\S]*?>/g) ?? []) {
      if (!/aria-controls/.test(tag)) broken.push(where)
    }
  }
  assert.deepEqual(broken, [], `role="tab" без aria-controls: ${broken.join(', ')}`)
})

// DESIGN.md: тон — точкой 6px, а не заливкой во всю плашку. Заливка кричит
// громче самого сообщения, и именно так когда-то выглядели два самых заметных
// экрана: «доска не загрузилась» и подсказка в настройках.
test('ни одно сообщение не залито цветом тона', () => {
  const css = readAllStyles()
  const filled: string[] = []
  for (const block of css.match(/[^}]*\{[^}]*\}/g) ?? []) {
    const [selector, body] = block.split('{')
    if (!/background:\s*var\(--(danger|warn|ok)-soft\)/.test(body)) continue
    const rule = selector.trim().split('\n').pop() ?? selector.trim()
    // кнопка с заливкой тоном — это кнопка, а не сообщение: у «Удалить»
    // заливка и есть её смысл. Правило про сообщения, поэтому кнопки и
    // их состояния наведения сюда не считаются.
    if (/(btn|button|:hover|:active|\.danger\b|armed)/.test(rule)) continue
    filled.push(rule)
  }
  assert.deepEqual(filled, [], `заливка тоном осталась: ${filled.join(' | ')}`)
})

// Провал молча — худший вид провала: человек ждёт результата, которого не будет.
test('каждое сообщение об ошибке объявляется диктором', () => {
  const silent: string[] = []
  for (const { where, text } of sources()) {
    for (const tag of text.match(/<div className="[^"]*-error"[^>]*>/g) ?? []) {
      if (!/role="alert"/.test(tag)) silent.push(`${where}: ${tag}`)
    }
  }
  assert.deepEqual(silent, [], `тихие ошибки: ${silent.join(' | ')}`)
})

test('@-подсказка объявляется списком, а активный пункт связан с полем', () => {
  // поле и подсказка переехали из PromptBar в свой компонент — семантика та же
  const bar = read('spaces/canvas/PromptComposerField.tsx')
  assert.match(bar, /role="listbox"/, 'подсказка обязана быть списком')
  assert.match(bar, /role="option"/, 'её пункты — пунктами списка')
  assert.match(bar, /aria-activedescendant=/, 'поле обязано указывать на активный пункт')
  assert.match(bar, /aria-expanded=/, 'и сообщать, раскрыт ли список')
})

// Результат генерации появляется на холсте молча: зрячий видит, как заглушка
// сменилась картинкой, незрячему сказать некому. Область объявлений обязана
// быть смонтирована, а центр задач — в неё говорить.
test('область объявлений смонтирована и связана с реестром задач', () => {
  assert.match(read('main.tsx'), /<LiveRegion\s*\/>/)
  assert.match(read('ui/LiveRegion.tsx'), /aria-live="polite"/)
  const center = read('spaces/canvas/GenerationTaskCenter.tsx')
  assert.match(center, /taskAnnouncement\(/)
  assert.match(center, /announce\(/)
})
