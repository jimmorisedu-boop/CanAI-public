import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { requestedProjectRef } from './activeProject.js'
import { projectKey } from './projectRef.js'

test('local board keys round-trip and legacy links remain local', () => {
  const ref = { source: 'local' as const, id: 'p1' }
  assert.deepEqual(requestedProjectRef(projectKey(ref)), ref)
  // Старая ссылка без приставки по-прежнему читается как локальная: у людей в
  // закладках лежат именно такие.
  assert.deepEqual(requestedProjectRef('p1'), { source: 'local', id: 'p1' })
  assert.throws(() => requestedProjectRef('remote:prj_1'), /Only local board links are available/)
})

test('a local board opens in a second tab through its namespaced key', async () => {
  const screen = await readFile(new URL('./ProjectsScreen.tsx', import.meta.url), 'utf8')
  assert.match(screen, /function boardUrl\(ref: ProjectRef\)/, 'адрес строится в одном месте')
  assert.match(screen, /projectKey\(ref\)/)
  assert.ok(
    !/\?project=\$\{encodeURIComponent\(p\.id\)\}/.test(screen),
    'голого идентификатора в ссылке не осталось',
  )
  assert.match(screen, /openProjectInBackground\(\{ source: 'local', id: project\.id \}\)/)
  assert.match(screen, /Open in new tab/)
})
