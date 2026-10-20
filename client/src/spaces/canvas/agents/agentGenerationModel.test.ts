import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInputItem, AgentPackageSummary } from '../../../../../packages/agent-protocol/index'
import type { CatalogModel } from '../../../types'
import {
  artifactRefsFromInputs,
  generationAuthorization,
  generationCatalog,
  generationLaunchInfo,
  invalidMediaInputCount,
  packageRequiresGeneration,
} from './agentGenerationModel'

const local = { source: 'local' as const, id: 'board-local' }
const cloud = { source: 'cloud' as const, id: 'board-cloud' }

function pkg(overrides: Partial<AgentPackageSummary> = {}): AgentPackageSummary {
  return {
    id: 'media-agent', name: 'Media agent', description: 'Media agent', version: '1.0.0', packageSha: 'sha', protocolVersion: '1.0',
    taskTypes: [{ id: 'make-image', label: 'Make image', description: 'Make image', outputKinds: ['image'] }],
    permissions: ['generation.request'], lifecycle: { pause: 'checkpoint', resume: true, cancel: true }, handshake: 'ready',
    ...overrides,
  }
}

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'image-a', name: 'Image A', kind: 'image', endpoint: 'fake/image-a', refs: true,
    maxTotalRefs: 4, params: [], pricing: { unit: 'image', usd: 0.08 },
    ...overrides,
  }
}

const catalog = generationCatalog({
  revision: 12,
  connection: { id: 'local-fal', kind: 'generation', status: 'ready' },
  models: [model(), model({ id: 'image-b', name: 'Image B', endpoint: 'fake/image-b', pricing: { unit: 'image', usd: 0.2 } }), model({ id: 'video-a', name: 'Video A', kind: 'video', endpoint: 'fake/video-a' })],
})

function type() {
  return pkg().taskTypes[0]!
}

function input(kind: AgentInputItem['kind'], artifactId: string, checksum: string): AgentInputItem {
  return { itemId: `${artifactId}-item`, artifactId, revision: 2, checksum, kind, caption: artifactId }
}

test('generation authorization pins local catalog/model, one call, consent, and ordered refs', () => {
  const refs = [input('image', 'first', 'a'.repeat(64)), input('image', 'second', 'b'.repeat(64))]
  const info = generationLaunchInfo({ pkg: pkg(), type: type(), projectRef: local, catalog, kind: 'image', modelId: 'image-b', refCount: refs.length, invalidRefCount: 0 })
  assert.equal(packageRequiresGeneration(pkg()), true)
  assert.equal(info?.available, true)
  assert.equal(info?.modelId, 'image-b')
  const artifactRefs = artifactRefsFromInputs(refs)
  assert.deepEqual(artifactRefs.map((ref) => ref.artifactId), ['first', 'second'])
  assert.deepEqual(generationAuthorization(info, 300_000, true, artifactRefs), {
    connectionId: 'local-fal', mediaTransferConsent: true, maxCostMicros: 300_000, maxCalls: 1,
    expectedModelId: 'image-b', expectedCatalogRevision: 12, artifactRefs,
  })
  assert.equal(generationAuthorization(info, 300_000, false, artifactRefs), null)
})

test('cloud board never falls back to the local generation provider', () => {
  const info = generationLaunchInfo({ pkg: pkg(), type: type(), projectRef: cloud, catalog, kind: 'image', modelId: null, refCount: 0, invalidRefCount: 0 })
  assert.equal(info?.available, false)
  assert.match(info?.unavailableReason ?? '', /Cloud/u)
  assert.equal(generationAuthorization(info, 300_000, true, []), null)
})

test('media refs fail closed until every selected input has a native checksum', () => {
  const refs = [input('image', 'valid', 'c'.repeat(64)), input('image', 'pending', 'asset-pending')]
  assert.equal(invalidMediaInputCount(refs), 1)
  const info = generationLaunchInfo({ pkg: pkg(), type: type(), projectRef: local, catalog, kind: 'image', modelId: null, refCount: 2, invalidRefCount: 1 })
  assert.equal(info?.available, false)
  assert.match(info?.unavailableReason ?? '', /file|saved/u)
  assert.deepEqual(artifactRefsFromInputs(refs).map((ref) => ref.artifactId), ['valid'])
})

test('generation catalog parser ignores malformed rows and preserves unavailable status', () => {
  const parsed = generationCatalog({ revision: 0, connection: { id: 'other', kind: 'llm', status: 'ready' }, models: [{ id: 'bad', name: 'Bad', kind: 'image' }, model()] })
  assert.equal(parsed.connection.status, 'unavailable')
  assert.equal(parsed.models.length, 1)
  const unavailable = generationCatalog({ revision: 12, connection: { id: 'local-fal', kind: 'generation', status: 'down' }, models: [model()] })
  assert.equal(unavailable.connection.status, 'unavailable')
})
