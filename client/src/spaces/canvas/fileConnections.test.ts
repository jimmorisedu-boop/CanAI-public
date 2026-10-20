import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** Local media should stay on the local server and use short-lived previews. */
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

test('размер по наведению отменяется, когда мышь ушла', async () => {
  const helpers = await read('./konva/itemHelpers.ts')
  const hook = helpers.slice(helpers.indexOf('export function useMediaSize'), helpers.indexOf('let canvasEl'))
  assert.match(hook, /fetch\(src, \{ method: 'HEAD', signal: controller\.signal \}\)/)
  assert.match(hook, /controller\.abort\(\)/)
})

test('архив спрашивает размеры не больше чем тремя запросами и отменяет их при закрытии', async () => {
  const sizes = await read('./archive/archiveSizes.ts')
  assert.match(sizes, /const CONCURRENCY = 3\b/)
  assert.match(sizes, /controller\.abort\(\)/)
})

test('миниатюры полки, архива и списка «@» используют локальные превью', async () => {
  for (const [file, pattern] of [
    ['./AssetBar.tsx', /<img src=\{screenPreviewSrc\(asset\.src, \d+\)\}/],
    ['./archive/ArchiveCard.tsx', /<img src=\{screenPreviewSrc\(entry\.src, \d+\)\}/],
    ['./PromptComposerField.tsx', /<img src=\{screenPreviewSrc\(ref\.src, \d+\)\}/],
  ] as const) {
    const source = await read(file)
    assert.match(source, pattern, file)
    assert.doesNotMatch(source, /<img src=\{(?:asset|entry|ref)\.src\}/, `${file}: original used for thumbnail`)
  }
})
