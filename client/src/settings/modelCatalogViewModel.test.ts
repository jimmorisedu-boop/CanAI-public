import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel } from '../types.js'
import { catalogRows } from './modelCatalogViewModel.js'

const models: CatalogModel[] = [
  { id: 'active-image', name: 'Active image', kind: 'image', endpoint: 'vendor/active', refs: false, params: [] },
  { id: 'archived-image', name: 'Archived image', kind: 'image', endpoint: 'vendor/archive', refs: false, params: [], lifecycle: 'archived' },
  { id: 'disabled-video', name: 'Disabled video', kind: 'video', endpoint: 'vendor/disabled', refs: false, params: [], lifecycle: 'disabled' },
]

test('archived saved model is excluded from new choices but remains executable', () => {
  const row = catalogRows(models, { query: '', kind: 'all', lifecycle: 'all' })
    .find(item => item.id === 'archived-image')!
  assert.equal(row.availableForNewChoice, false)
  assert.equal(row.executable, true)
})

test('catalog search and filters match endpoint without losing disabled models', () => {
  const rows = catalogRows(models, { query: 'DISABLED', kind: 'video', lifecycle: 'disabled' })
  assert.deepEqual(rows.map(row => row.id), ['disabled-video'])
  assert.equal(rows[0]?.executable, false)
})
