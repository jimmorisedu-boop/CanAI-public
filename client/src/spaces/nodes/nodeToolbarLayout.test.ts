import assert from 'node:assert/strict'
import test from 'node:test'
import { readAllStyles } from '../../testStyles'

test('полный ряд нод прокручивается внутри тулбара, а не растягивает страницу', () => {
  const styles = readAllStyles()
  const toolbar = styles.match(/\.nodes-toolbar\s*\{([^}]+)\}/)?.[1]
  const space = styles.match(/\.nodes-space\s*\{([^}]+)\}/)?.[1]

  assert.match(space ?? '', /overflow:\s*hidden/)
  assert.match(toolbar ?? '', /max-width:\s*calc\(100%\s*-\s*32px\)/)
  assert.match(toolbar ?? '', /overflow-x:\s*auto/)
  assert.match(toolbar ?? '', /white-space:\s*nowrap/)
})
