import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = readFileSync(fileURLToPath(new URL('./TabletHelp.tsx', import.meta.url)), 'utf8')
const styles = readFileSync(fileURLToPath(new URL('./tablet.css', import.meta.url)), 'utf8')

test('tablet help keeps the complete gesture vocabulary and shared guide entry point', () => {
  const titles = [...source.matchAll(/title: '([^']+)'/g)].map((match) => match[1])
  assert.equal(titles.length, 13)
  assert.deepEqual(titles, [
    'Select',
    'Marquee select',
    'Prompt panel',
    'Interface size',
    'Move around the canvas',
    'Open large',
    'Resize',
    'Object menu',
    'Undo',
    'Redo',
    'Copy and paste',
    'Hide interface',
    'Show all',
  ])
  assert.match(source, /role="tablist"/)
  assert.match(source, />\s*\{t\('Guides'\)\}\s*</)
  assert.match(source, />\s*\{t\('Gestures'\)\}\s*</)
  assert.match(source, /initialTopicId="tablet-lan"/)
  assert.match(source, /showBoardActions=\{false\}/)
})

test('tablet guides reserve a touch-sized reader and keep topic content scrollable', () => {
  assert.match(styles, /\.tablet-help-guides[\s\S]*?min-height: 0/)
  assert.match(styles, /\.tablet-help-guides \.help-topic-detail[\s\S]*?min-height: 0/)
  assert.match(styles, /\.tablet-help-guides \.help-step-image[\s\S]*?object-fit: contain/)
  assert.match(styles, /\.tablet-help-tabs button[\s\S]*?min-height: var\(--tablet-tap\)/)
})
