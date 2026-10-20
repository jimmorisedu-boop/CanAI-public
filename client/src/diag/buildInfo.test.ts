import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { clientBuild, formatBuild } from './buildInfo.js'

/**
 * Номер сборки страницы (пункт 5.1). Вшивает его сборщик; в тестах сборщика
 * нет, и честный ответ — «неизвестна», а не выдуманный номер.
 */

test('номер сборки показывается коротко, с датой и пометкой о правках', () => {
  assert.equal(clientBuild(), null, 'без сборщика номера нет')
  assert.equal(formatBuild(null), 'unknown')
  assert.equal(formatBuild({ version: '0.1.0', commit: null, date: null }), '0.1.0 · commit unknown')
  const when = new Date('2026-09-26T14:52:07+03:00')
  const day = `${String(when.getMonth() + 1).padStart(2, '0')}/${String(when.getDate()).padStart(2, '0')}/${when.getFullYear()}`
  assert.equal(
    formatBuild({ version: '0.1.0', commit: '7aa625f3bbb9', date: '2026-09-26T14:52:07+03:00' }),
    `0.1.0 · 7aa625f on ${day}`,
  )
  assert.match(formatBuild({ version: '0.1.0', commit: '7aa625f3bbb9', date: null, dirty: true }), /\(with changes\)$/)
})

test('СТОРОЖ: обе страницы вшивают номер, а правило одно с сервером', async () => {
  for (const config of ['../../vite.config.ts', '../../vite.tablet.config.ts']) {
    const source = await readFile(new URL(config, import.meta.url), 'utf8')
    assert.match(source, /buildDefine\(\)/, `${config}: номер сборки не вшивается`)
  }
  const helper = await readFile(new URL('../../viteBuildInfo.ts', import.meta.url), 'utf8')
  assert.match(helper, /from '\.\.\/server\/src\/buildInfo'/, 'правило чтения номера — только серверное')
  const diagnostics = await readFile(new URL('../settings/DiagnosticsSection.tsx', import.meta.url), 'utf8')
  assert.match(diagnostics, /<dt>Interface<\/dt>/)
  assert.match(diagnostics, /<dt>Server<\/dt>/)
})
