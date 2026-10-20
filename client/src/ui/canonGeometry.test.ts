import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'

// ⚠️ Сторож против тихого возврата разнобоя.
//
// 21.08.2026 форма рабочих элементов сведена в один файл (controls.css): было
// 72 правила кнопок и 69 разных сочетаний отступа, скругления и кегля. Но
// канон сам по себе ничего не защищает: достаточно, чтобы кто-нибудь снова
// объявил у покрытого места своё скругление — и через месяц окна опять
// разъедутся, причём незаметно, по одному правилу за раз.
//
// Этот тест перечисляет места, которые канон уже держит, и падает, если такое
// место объявляет геометрию само. Исключения существуют, но они ИМЕНОВАНЫ:
// размер бывает свойством поверхности (в шапке ряд крупнее, промпт-бар — ряд
// акцента), форма — никогда.

const stylesDir = new URL('../styles/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, stylesDir), 'utf8')

/** Свойства, которыми владеет канон: объявлять их на месте — значит спорить. */
const OWNED = ['padding', 'border-radius', 'font-size', 'border', 'background']

/** Размер — законное свойство поверхности, форма — нет. */
const SIZE_ONLY = ['height', 'min-height', 'width', 'min-width']

/**
 * Исключения: место, где размер задан намеренно, и ПОЧЕМУ. Пустого списка тут
 * быть не должно — если исключение не объяснено словами, оно неотличимо от
 * забытого разнобоя.
 */
const ALLOWED = new Map<string, string>([
  ['price-params.css .kind-toggle', 'промпт-бар — ряд акцента: дорожка в рост кнопки запуска, иначе ряд едет'],
  ['price-params.css .prompt-bar .kind-toggle button', 'сегмент заполняет дорожку промпт-бара изнутри'],
  ['settings.css .settings-modal input:not([type="checkbox"]), .settings-modal select', 'поля настроек шире прочих: текст в них дышит'],
  ['compare.css .compare-modes', 'дорожка режимов плавает над кадром — у неё своё стекло'],
  ['notices.css .export-group-row', 'строка списка, а не кнопка: своя высота законна'],
  ['gallery.css .project-menu-btn', 'карточка доски — цель под палец 40px, у неё свой сторож в galleryScalabilityUi'],
])

function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(css))) {
    const selector = match[1].split('\n').map((line) => line.trim()).filter(Boolean).join(' ').trim()
    if (!selector || selector.startsWith('@')) continue
    out.push({ selector, body: match[2] })
  }
  return out
}

/** Селекторы, которые канон уже держит. */
function canonSelectors(): string[] {
  const canon = read('controls.css')
  const list = new Set<string>()
  for (const { selector } of rules(canon)) {
    for (const part of selector.split(',')) {
      const clean = part.trim()
      if (!clean.startsWith('.') || clean.startsWith('.ui-')) continue
      // состояния держит тот же канон — нас интересует само место
      list.add(clean.replace(/:(hover|focus|active|disabled|not)\b.*$/, '').trim())
    }
  }
  return [...list].filter(Boolean)
}

function declares(body: string, props: string[]): string[] {
  return props.filter((prop) => new RegExp(`(?:^|;|\\s)${prop}\\s*:`).test(body))
}

test('места, покрытые каноном, не объявляют форму заново', () => {
  const canon = canonSelectors()
  const нарушения: string[] = []

  for (const name of readdirSync(stylesDir).filter((file) => file.endsWith('.css'))) {
    if (name === 'controls.css' || name === 'tokens.css') continue
    for (const { selector, body } of rules(read(name))) {
      // состояния (:hover, .on) могут менять цвет — это не форма
      if (/:(hover|focus|active|disabled)|\.on\b/.test(selector)) continue
      const covered = canon.filter((c) => selector === c || selector.split(',').map((s) => s.trim()).includes(c))
      if (covered.length === 0) continue
      const own = declares(body, OWNED)
      if (own.length === 0) continue
      const key = `${name} ${selector}`
      if (ALLOWED.has(key)) continue
      нарушения.push(`${key} → ${own.join(', ')}`)
    }
  }

  assert.deepEqual(
    нарушения,
    [],
    'форма должна жить в controls.css. Если размер здесь намеренный — впишите место и причину в ALLOWED:\n' + нарушения.join('\n'),
  )
})

test('исключения по размеру названы поимённо, а не списком без причин', () => {
  for (const [место, причина] of ALLOWED) {
    assert.ok(причина.length > 12, `исключение ${место} должно объяснять причину словами`)
  }
})

test('канон описывает все роли, о которых договорились', () => {
  const canon = read('controls.css')
  for (const роль of ['.ui-btn', '.ui-btn.primary', '.ui-btn.quiet', '.ui-icon-btn', '.ui-toggle', '.ui-chip', '.ui-count', '.ui-field']) {
    assert.ok(canon.includes(роль), `в каноне нет роли ${роль}`)
  }
  // Геометрия — только ролями: своё число здесь и есть будущий разнобой.
  assert.doesNotMatch(canon, /border-radius:\s*\d+px/)
  assert.doesNotMatch(canon, /font-size:\s*\d+px/)
})
