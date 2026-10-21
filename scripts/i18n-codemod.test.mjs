import assert from 'node:assert/strict'
import test from 'node:test'
import { transformSource } from './i18n-codemod.mjs'

test('i18n codemod subscribes memo and forwardRef components, not ordinary callbacks', () => {
  const source = [
    "import { forwardRef, memo } from 'react'",
    "const Card = memo(function Card() { return <button>{t('Save')}</button> })",
    "const Forward = forwardRef((props, ref) => <div title=\"Open board\">{t('Save')}</div>)",
    "const render = () => t('Save')",
  ].join('\n')
  const keys = new Set(['Save', 'Open board'])
  const result = transformSource(source, 'client/src/ui/CodemodFixture.tsx', keys)

  assert.equal(result.changed, true)
  assert.equal((result.source.match(/const t = useT\(\)/gu) ?? []).length, 2)
  assert.match(result.source, /const render = \(\) => t\('Save'\)/u)
  assert.doesNotMatch(result.source, /const render = \(\) => \{[\s\S]*useT/u)
  assert.equal(transformSource(result.source, 'client/src/ui/CodemodFixture.tsx', keys).changed, false)
})

test('i18n codemod preserves predicates, identifiers, API enums, and user content', () => {
  const source = [
    "import React from 'react'",
    "const Example = ({ kind, userContent, userLabel }) => (<section className=\"status\" id=\"save-id\" data-kind=\"image\" value=\"image\" aria-label=\"Save\">{kind === 'image' ? 'Save' : 'Cancel'}<span>{userContent}</span><button aria-label={userLabel}>{userLabel}</button></section>)",
    "const payload = { kind: 'image', model: 'vendor/image', status: 'queued' }",
  ].join('\n')
  const keys = new Set(['Save', 'Cancel'])
  const result = transformSource(source, 'client/src/ui/CodemodSafetyFixture.tsx', keys)

  assert.equal(result.changed, true)
  assert.match(result.source, /className="status"/u)
  assert.match(result.source, /id="save-id"/u)
  assert.match(result.source, /data-kind="image"/u)
  assert.match(result.source, /value="image"/u)
  assert.match(result.source, /kind === 'image'/u)
  assert.match(result.source, /const payload = \{ kind: 'image', model: 'vendor\/image', status: 'queued' \}/u)
  assert.match(result.source, /aria-label=\{t\('Save'\)\}/u)
  assert.match(result.source, /kind === 'image' \? t\('Save'\) : t\('Cancel'\)/u)
  assert.match(result.source, /<span>\{userContent\}<\/span>/u)
  assert.match(result.source, /aria-label=\{userLabel\}>\{userLabel\}/u)
  assert.equal(transformSource(result.source, 'client/src/ui/CodemodSafetyFixture.tsx', keys).changed, false)
})
