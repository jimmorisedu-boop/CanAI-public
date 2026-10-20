import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  isSettingsSection,
  resolveSettingsSection,
} from './settingsSections.js'

test('у каждого раздела есть имя и строка о содержимом', () => {
  assert.ok(SETTINGS_SECTIONS.length >= 2)
  for (const section of SETTINGS_SECTIONS) {
    assert.ok(section.label.trim().length > 0, `${section.id}: нет имени`)
    assert.ok(section.summary.trim().length > 0, `${section.id}: не сказано, что внутри`)
  }
  const ids = SETTINGS_SECTIONS.map((section) => section.id)
  assert.equal(new Set(ids).size, ids.length, 'повторяющийся id раздела')
  assert.ok(isSettingsSection(DEFAULT_SETTINGS_SECTION), 'раздел по умолчанию должен существовать')
})

test('раздел генерации объединяет fal.ai и модели', () => {
  assert.deepEqual(SETTINGS_SECTIONS.find(item => item.id === 'generation'), {
    id: 'generation',
    label: 'fal.ai and models',
    summary: 'Key, default models, and local fal.ai catalog',
  })
})

// ⚠️ Раздел приходит явным значением. Угадывание по тексту подсказки ломается
// от любой переформулировки — на этом уже обожглись коды ответов публикации.
test('неизвестный раздел не роняет окно, а открывает первый', () => {
  assert.equal(resolveSettingsSection('editor'), 'editor')
  assert.equal(resolveSettingsSection('нет-такого'), DEFAULT_SETTINGS_SECTION)
  assert.equal(resolveSettingsSection(undefined), DEFAULT_SETTINGS_SECTION)
  assert.equal(resolveSettingsSection(null), DEFAULT_SETTINGS_SECTION)
  assert.equal(isSettingsSection('assistant'), false)
  assert.equal(resolveSettingsSection('assistant'), DEFAULT_SETTINGS_SECTION)
})

// ⚠️ Раздел, объявленный в списке, но не нарисованный в окне, недостижим — а
// человек будет искать в нём настройку. И наоборот: нарисованный, но не
// объявленный, не появится в боковом списке.
test('список разделов и окно не расходятся', () => {
  const modal = readFileSync(new URL('./SettingsModal.tsx', import.meta.url), 'utf8')
  const rendered = new Set(
    [...modal.matchAll(/section === '([a-z]+)'/g)].map((match) => match[1]!),
  )
  const declared = new Set(SETTINGS_SECTIONS.map((entry) => entry.id))

  for (const id of declared) {
    assert.ok(rendered.has(id), `раздел «${id}» объявлен, но в окне не рисуется`)
  }
  for (const id of rendered) {
    assert.ok(declared.has(id), `раздел «${id}» рисуется, но в списке его нет — в него не попасть`)
  }
})

// ⚠️ Список разделов не имеет права ездить при переключении: человек целится в
// следующий раздел, а кнопка уходит из-под курсора. Нижнего предела высоты для
// этого МАЛО — он держит только короткие разделы, а высокий всё равно
// растягивает окно. Замер 18.09.2026 на восьми разделах: «fal.ai и модели»
// 747px против 520 у остальных, весь список подпрыгивал на 114px. Правило
// писалось, когда разделов было шесть и такого высокого среди них не было.
test('высота окна настроек закреплена, а не ограничена снизу', () => {
  const css = readFileSync(new URL('../styles/settings.css', import.meta.url), 'utf8')
  const at = css.indexOf('.settings-layout > .settings-body {')
  assert.notEqual(at, -1, 'правило высоты окна пропало')
  const rule = css.slice(at, css.indexOf('}', at))
  assert.match(rule, /(^|[^-])height:\s*min\(/u, 'высота задаётся явно')
  assert.doesNotMatch(rule, /min-height:/u, 'min-height держит только короткие разделы — окно всё равно прыгает')
})

test('local settings expose LAN access and omit team connections', () => {
  assert.equal(isSettingsSection('team'), false)
  assert.equal(resolveSettingsSection('team'), DEFAULT_SETTINGS_SECTION)
  assert.equal(isSettingsSection('remote'), true)
  const remote = readFileSync(new URL('./RemoteAccessSection.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(remote, /CloudTablet|cloudAccount|cloudTabletUrl/u)
  assert.match(remote, /api\.setRemotePin/u)
  assert.match(remote, /api\.setRemoteEnabled/u)
})
