// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { readFileSync } from 'node:fs'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'

const projectsScreen = readFileSync(new URL('./ProjectsScreen.tsx', import.meta.url), 'utf8')
const trashModal = readFileSync(new URL('./TrashModal.tsx', import.meta.url), 'utf8')
const versionsModal = readFileSync(new URL('./VersionsModal.tsx', import.meta.url), 'utf8')

function section(start: string, end: string): string {
  const startAt = projectsScreen.indexOf(start)
  const endAt = end ? projectsScreen.indexOf(end, startAt + start.length) : projectsScreen.length
  return startAt < 0 ? '' : projectsScreen.slice(startAt, endAt < 0 ? projectsScreen.length : endAt)
}

test('gallery keeps local cards, shows one failure, and blocks local actions when unavailable', () => {
  assert.ok(projectsScreen.includes('<GalleryFailureState failure={failure}'))
  assert.ok(projectsScreen.includes('setFailure(isLocalServiceUnavailable(cause)'))
  assert.ok(projectsScreen.includes('disabled={busy || serviceUnavailable}'))
  assert.ok(projectsScreen.includes('disabled={serviceUnavailable}'))
  assert.ok(projectsScreen.includes("onServiceUnavailable={() => setFailure({ kind: 'service-unavailable' })}"))
  assert.ok(projectsScreen.includes('setRecoveryNeedsReview(status.recoveryNeedsReview === true)'))
})

test('rename, pin, trash, and undo update the local gallery after each request', () => {
  const rename = section('const commitRename = async (project: ProjectMeta) => {', 'const togglePin')
  assert.ok(rename.includes('api.renameProject(project.id, name)'))
  assert.ok(rename.includes('setProjects((current) => current?.map('))
  assert.ok(rename.includes('showErrorToast'))

  const pin = section('const togglePin = async (project: ProjectMeta) => {', 'const remove')
  assert.ok(pin.includes('api.updateProject(project.id, { pinned: !project.pinned })'))
  assert.ok(pin.includes('setProjects((current) => current?.map('))
  assert.ok(pin.includes('showErrorToast'))

  const remove = section('const remove = async (project: ProjectMeta) => {', 'const undo')
  assert.ok(remove.includes('api.deleteProject(project.id)'))
  assert.ok(remove.includes('setProjects((current) => current?.filter('))
  assert.ok(remove.includes('setUndoProject(project)'))

  const undo = section('const undo = async () => {', 'return <div')
  assert.ok(undo.includes('api.restoreTrashedProject(project.id)'))
  assert.ok(undo.includes('setProjects((current) => [result.project, ...(current ?? [])])'))
})

test('Trash and Versions report local service unavailability to their owner', () => {
  for (const source of [trashModal, versionsModal]) {
    assert.ok(source.includes('isLocalServiceUnavailable(cause)'))
    assert.ok(source.includes('onServiceUnavailable()'))
    assert.ok(source.includes('onClose()'))
  }
})
