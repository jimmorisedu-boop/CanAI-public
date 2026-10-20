import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { jsRuntimeArgs } from './ytRuntime.js'

// Жалоба 18.08.2026: «не все ссылки скачиваются». Причина — yt-dlp с 2026 года
// требует JS-движок для YouTube, а по умолчанию ищет только deno, которого у
// нас нет. Замер на живой ссылке: БЕЗ движка доступен только формат 18 (360p),
// С движком — 96 (1080p), а на части роликов без него не остаётся ничего.

test('движком назначается тот самый Node, на котором работает сервер', () => {
  // Своего компонента качать не надо: Node есть всегда, и в дистрибутиве он
  // лежит рядом (runtime/node).
  assert.deepEqual(jsRuntimeArgs(), ['--js-runtimes', `node:${process.execPath}`])
})

test('путь идёт отдельным аргументом — пробелы в нём не ломают вызов', () => {
  // «C:\Program Files\nodejs\node.exe» — обычный путь на Windows.
  const [flag, value] = jsRuntimeArgs()
  assert.equal(flag, '--js-runtimes')
  assert.ok(!value.includes('"'), 'кавычек быть не должно: аргумент передаётся массивом')
})

test('движок передаётся ВО ВСЕ вызовы yt-dlp, а не только в скачивание', () => {
  // Их три, и каждый ломается без движка по-своему: метаданные ссылки не
  // находят форматов, превью не получает картинку, скачивание берёт 360p.
  for (const file of ['mediaImportManager.ts', 'mediaLinkResolver.ts', 'extractorPreview.ts']) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.match(source, /jsRuntimeArgs\(\)/, `${file} должен передавать JS-движок`)
  }
})
