import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentPanelBottomReserve,
  agentPanelCompactPosition,
  agentStageLabel,
  agentStatusLabel,
  agentTaskLabel,
  artifactMediaHref,
  artifactPreviewHref,
  reviewArtifact,
  reviewArtifactMatch,
} from './agentPanelPresentation'

test('agent panel presents task and stage ids as human labels', () => {
  const packages = [{
    id: 'canai.demo', name: 'Демо', description: '', version: '1', packageSha: 'sha', protocolVersion: '1.0' as const,
    taskTypes: [{ id: 'custom-plan', label: 'План команды', description: '', outputKinds: ['plan'] }],
    permissions: [], lifecycle: { pause: 'checkpoint' as const, resume: true as const, cancel: true as const }, handshake: 'ready' as const,
  }]
  assert.equal(agentTaskLabel('demo-plan', packages), 'Demo plan')
  assert.equal(agentTaskLabel('custom-plan', packages), 'План команды')
  assert.equal(agentTaskLabel('unknown-id', packages), 'Agent task')
  assert.equal(agentStageLabel('review'), 'Result review')
  assert.equal(agentStatusLabel('awaiting_review', { awaiting_review: 'Waiting for a decision' }), 'Waiting for a decision')
  assert.equal(agentStatusLabel('unknown-status', {}), 'Updating status')
})

test('agent panel reserves the prompt dock and matches review artifacts exactly', () => {
  assert.equal(agentPanelBottomReserve(900, 560), 356)
  assert.equal(agentPanelBottomReserve(900, 850), 112)

  const artifact = {
    artifactId: 'artifact-1', revision: 2, checksum: 'checksum-2', kind: 'plan' as const,
    caption: 'План', mimeType: 'text/plain', sizeBytes: 4, mediaSrc: '/media/plan.txt' as const,
    provenance: 'generated' as const, text: 'Шаг 1',
  }
  assert.equal(reviewArtifact([artifact], { artifactId: 'artifact-1', revision: 2, checksum: 'checksum-2' }), artifact)
  assert.equal(reviewArtifact([artifact], { artifactId: 'artifact-1', revision: 1, checksum: 'checksum-2' }), undefined)
})

test('review material distinguishes not-yet-loaded from a replaced revision', () => {
  const artifact = {
    artifactId: 'artifact-1', revision: 2, checksum: 'checksum-2', kind: 'plan' as const,
    caption: 'План', mimeType: 'text/plain', sizeBytes: 4, mediaSrc: '/media/plan.txt' as const,
    provenance: 'generated' as const, text: 'Шаг 1',
  }
  const material = { artifactId: 'artifact-1', revision: 2, checksum: 'checksum-2' }
  assert.deepEqual(reviewArtifactMatch([artifact], material), { state: 'ready', artifact })
  assert.deepEqual(reviewArtifactMatch([artifact], { ...material, checksum: 'new-checksum' }), { state: 'stale' })
  assert.deepEqual(reviewArtifactMatch([], material), { state: 'loading' })
})

test('text-only Cloud material never turns a missing URL into a link', () => {
  const textOnly = {
    artifactId: 'artifact-text', revision: 1, checksum: 'checksum-text', kind: 'text' as const,
    caption: 'Текст', mimeType: 'text/plain', sizeBytes: 4,
    provenance: 'generated' as const, text: 'План',
  } as unknown as Parameters<typeof artifactMediaHref>[0]
  assert.equal(artifactMediaHref(textOnly), undefined)
})

test('review preview prefers the durable preview URL without requiring an original', () => {
  const previewOnly = {
    artifactId: 'artifact-image', revision: 1, checksum: 'checksum-image', kind: 'image' as const,
    caption: 'Кадр', mimeType: 'image/webp', sizeBytes: 4,
    provenance: 'generated' as const, previewSrc: '/media/preview.webp' as const,
  }
  assert.equal(artifactPreviewHref(previewOnly), '/media/preview.webp')
  assert.equal(artifactMediaHref(previewOnly), undefined)
})

test('native image without preview uses its authenticated media URL as visible fallback', () => {
  const nativeImage = {
    artifactId: 'native-image', revision: 1, checksum: 'a'.repeat(64), kind: 'image' as const,
    caption: 'Кадр', mimeType: 'image/png', sizeBytes: 4,
    provenance: 'reference' as const, mediaSrc: '/media/native.png' as const,
  }
  assert.equal(artifactPreviewHref(nativeImage), '/media/native.png')
})

test('compact agent toggle chooses measured space beside the dock and asset rail', () => {
  const canvas = { left: 0, right: 1280, top: 52, bottom: 720 }
  const desktop = agentPanelCompactPosition(canvas, [
    { left: 240, right: 1040, top: 72, bottom: 702 },
    { left: 1208, right: 1264, top: 16, bottom: 610 },
  ])
  assert.deepEqual(desktop, { left: 1048, top: 16 })

  const narrow = agentPanelCompactPosition(
    { left: 0, right: 768, top: 52, bottom: 720 },
    [
      { left: 60, right: 708, top: 72, bottom: 702 },
      { left: 696, right: 752, top: 16, bottom: 610 },
      { left: 8, right: 50, top: 66, bottom: 108 },
    ],
  )
  assert.deepEqual(narrow, { left: 8, top: 60 })
})

test('compact agent toggle has no unsafe fallback when the measured dock fills the narrow viewport', () => {
  const actualNarrowBounds = agentPanelCompactPosition(
    { left: 0, right: 768, top: 52, bottom: 720 },
    [
      { left: 10, right: 758, top: 77.7, bottom: 710 },
      { left: 696, right: 752, top: 68, bottom: 610 },
      { left: 14, right: 56, top: 66, bottom: 108 },
    ],
  )
  assert.equal(actualNarrowBounds, null)
})
