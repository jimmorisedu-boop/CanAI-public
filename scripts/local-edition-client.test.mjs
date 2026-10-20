import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  isLocalClientSourcePath,
  transformLocalClientSource,
} from './local-edition-client.mjs'

test('local client boundary excludes Cloud, collaboration, and shared-board implementations', () => {
  for (const path of [
    'client/src/spaces/canvas/collaboration/controller.ts',
    'client/src/spaces/canvas/cloudProjectSync.ts',
    'client/src/spaces/canvas/agents/cloudAgentClient.ts',
    'client/src/projects/CloudBoardMembers.tsx',
    'client/src/settings/CloudRouteRow.tsx',
    'client/src/tablet/cloudRuntime.ts',
    'client/src/ui/CloudCommentsButton.tsx',
    'client/public/help/cloud-boundary-1.svg',
    'client/src/cloudConnection.ts',
    'client/src/spaces/canvas/dockCatalogTestKit.ts',
    'client/src/spaces/canvas/personalDraftStatus.test.tsx',
    'client/src/spaces/canvas/quietReconnect.test.ts',
  ]) assert.equal(isLocalClientSourcePath(path), false, path)
})

test('local client boundary keeps local canvas, generation, editor, workflow, and LAN tablet sources', () => {
  for (const path of [
    'client/src/App.tsx',
    'client/src/api.ts',
    'client/src/spaces/canvas/CanvasSpace.tsx',
    'client/src/spaces/nodes/NodesSpace.tsx',
    'client/src/projects/ProjectsScreen.tsx',
    'client/src/tablet/TabletApp.tsx',
    'client/src/tablet/lanRuntime.ts',
    'client/src/tablet/remoteSession.ts',
    'client/src/help/content/guide.json',
    'client/public/help/tablet-lan-1.svg',
    'client/src/ui/useSharedZoom.ts',
    'client/src/ui/useSharedZoom.test.ts',
  ]) assert.equal(isLocalClientSourcePath(path), true, path)
  assert.equal(isLocalClientSourcePath('server/src/cloudBoardGateway.ts'), true)
  assert.equal(isLocalClientSourcePath('../client/src/App.tsx'), false)
  assert.equal(isLocalClientSourcePath('C:/repo/client/src/App.tsx'), false)
})

test('irrelevant files are returned byte-for-byte', () => {
  const source = 'export const unchanged = true\n'
  assert.equal(transformLocalClientSource('server/src/index.ts', source), source)
  assert.equal(transformLocalClientSource('client/src/canvasStore.ts', source), source)
})

test('help transform drops the Cloud boundary topic while retaining local LAN and navigation topics', () => {
  const guide = {
    categories: [
      { id: 'basics', title: 'Basics' },
      { id: 'cloud', title: 'Cloud' },
    ],
    topics: [
      { id: 'local', category: 'basics', title: 'Local board', related: ['cloud'] },
      { id: 'tablet-lan', category: 'basics', title: 'LAN tablet', body: 'Open the local address. On a network board, use participants.' },
      { id: 'cloud-boundary', category: 'cloud', title: 'Cloud connections', body: 'Use the team server.' },
    ],
  }
  const output = JSON.parse(transformLocalClientSource(
    'client/src/help/content/guide.json',
    `${JSON.stringify(guide)}\n`,
  ))
  assert.deepEqual(output.categories, [{ id: 'basics', title: 'Basics' }])
  assert.equal(output.topics.some((topic) => topic.id === 'tablet-lan'), true)
  assert.equal(output.topics.some((topic) => topic.id === 'cloud-boundary'), false)
  assert.deepEqual(output.topics.find((topic) => topic.id === 'local'), { id: 'local', category: 'basics', title: 'Local board', related: [] })
})

test('client package transform removes Cloud-only build/test entry points but keeps local build', () => {
  const source = JSON.stringify({ scripts: {
    build: 'tsc --noEmit && vite build && npm run build:tablet:cloud',
    'build:tablet:cloud': 'vite build --mode cloud',
    check: 'tsc --noEmit',
  } })
  const output = JSON.parse(transformLocalClientSource('client/package.json', source))
  assert.equal(output.scripts.build, 'tsc --noEmit && vite build')
  assert.equal(output.scripts['build:tablet:cloud'], undefined)
  assert.equal(output.scripts.check, 'tsc --noEmit')
})

test('CanvasStore transform keeps local mutation APIs while removing remote asset sizing', () => {
  const source = [
    "import type { BoardCollaborationPort } from '../collaboration/types'",
    '    const cloudImageSize = !isVideo',
    '      ? await probeCloudAsset(src)',
    '      : null',
    '    } else if (cloudImageSize) {',
    '      size = cloudImageSize',
    '    } else {',
    '    if (completed && cloudImageSize) {',
    '      await api.fetchCloudAsset(completed)',
    '    }',
    '  }',
    '  pinAsset(item)',
  ].join('\n')
  const output = transformLocalClientSource('client/src/spaces/canvas/konva/canvasStore.ts', source)
  assert.match(output, /type BoardCollaborationPort/)
  assert.match(output, /pinAsset\(item\)/)
  assert.doesNotMatch(output, /cloudImageSize|probeCloudAsset|fetchCloudAsset/)
})

test('Konva and prompt-chat transforms leave local transports and no collaboration UI', () => {
  const konva = transformLocalClientSource(
    'client/src/spaces/canvas/konva/KonvaCanvas.tsx',
    [
      "import { prewarmList, prewarmSignature, sendPrewarm } from './cloudPreviewPrewarm'",
      "import { CollaborationOverlay } from './CollaborationOverlay'",
      'const entries = prewarmList(items, view, 1)',
      '<CollaborationOverlay store={store} camera={cam} />',
    ].join('\n'),
  )
  assert.match(konva, /const prewarmList =/)
  assert.doesNotMatch(konva, /cloudPreviewPrewarm|CollaborationOverlay/)

  const chat = transformLocalClientSource(
    'client/src/spaces/canvas/promptChatStore.ts',
    [
      "import { api, ApiError, cloudPromptChatApi } from '../../api'",
      "import type { PromptChatHttpTransport } from './promptChatTransport'",
      'let cloudTransportOverride: PromptChatHttpTransport | null = null',
      'export function setBrowserCloudPromptChatTransport(next: PromptChatHttpTransport | null): void { cloudTransportOverride = next }',
      'const promptTransport = createPromptChatTransport(api, () => cloudTransportOverride ?? cloudPromptChatApi)',
    ].join('\n'),
  )
  assert.match(chat, /createPromptChatTransport\(api, api\)/)
  assert.doesNotMatch(chat, /cloudPromptChatApi|cloudTransportOverride|PromptChatHttpTransport/)
})

test('tablet prompt transform removes dead remote conversation refresh callbacks', () => {
  const source = [
    'const assistantSelection = useThing({',
    '  onChanged: () => {',
    '    if (true) return',
    '    const activeId = store.getSnapshot(projectId).activeId',
    '    if (activeId) void store.refresh(projectId, activeId)',
    '  },',
    '})',
    '<Widget onChanged={() => {',
    '  if (true) return',
    '  const activeId = store.getSnapshot(projectId).activeId',
    '  if (activeId) void store.refresh(projectId, activeId)',
    '}} />',
  ].join('\n')
  const output = transformLocalClientSource('client/src/tablet/TabletPrompt.tsx', source)
  assert.doesNotMatch(output, /if \(true\) return|store\.refresh/)
})

test('API reveal transform accepts only local media paths', () => {
  const output = transformLocalClientSource(
    'client/src/api.ts',
    [
      "import { localCopyForCloudReveal } from './spaces/canvas/cloudExternalEdit'",
      '  revealFile: async (src: string) => {',
      '    const localSrc = await localCopyForCloudReveal(src)',
      "    return post<{ ok: boolean }>('/api/media/reveal', { src: localSrc })",
      '  },',
    ].join('\n'),
  )
  assert.equal(output.includes("if (!src.startsWith('/media/'))"), true)
  assert.equal(output.includes("post<{ ok: boolean }>('/api/media/reveal', { src })"), true)
  assert.equal(output.includes('localCopyForCloudReveal'), false)
})

test('local navigation Help SVG overlays show Board controls without collaboration UI', () => {
  for (const file of ['navigation-shortcuts-1.svg', 'navigation-shortcuts-2.svg']) {
    const overlay = resolve('local-edition/overrides/client/public/help', file)
    const source = readFileSync(existsSync(overlay) ? overlay : resolve('client/public/help', file), 'utf8')
    assert.match(source, /viewBox="0 0 640 360"/, file)
    assert.match(source, /Shift \+ 1/, file)
    assert.match(source, /Board|Canvas|map/, file)
    assert.doesNotMatch(source, /participants?|teammate|follow|on board/i, file)
  }
})

test('local assistant sends original references without the excluded Cloud frame helper', () => {
  const name = 'client/src/spaces/canvas/assistantAsk.ts'
  const output = transformLocalClientSource(name, readFileSync(name, 'utf8'))
  assert.equal(isLocalClientSourcePath('client/src/spaces/canvas/assistantCloudRefs.ts'), false)
  assert.doesNotMatch(output, /assistantCloudRefs|assistantRefsFor|assistantRefsNeedFrames|FRAME_NOTICE|dismissToast|\bnotify\(/)
  assert.match(output, /const prepared = frozen/)
  assert.match(output, /prepared\.map\(attachmentFromSelection\)/)
  assert.equal(transformLocalClientSource(name, output), output)
})

test('both macro launchers pass selection inputs to the shared price estimator', () => {
  for (const name of [
    'client/src/spaces/canvas/PromptMacros.tsx',
    'local-edition/overrides/client/src/spaces/canvas/PromptMacros.tsx',
  ].filter(existsSync)) {
    const source = readFileSync(name, 'utf8')
    assert.match(source, /estimateMacroCost\(\s*graph,\s*models,\s*runCount,\s*(?:\/\/[^\n]*\n\s*)?macroCostContext\(refs\),/u, name)
  }
})

test('batch planning tests use the exported local catalogue fixture', () => {
  const name = 'client/src/spaces/canvas/actionDockBatchPlanning.test.ts'
  const output = transformLocalClientSource(name, readFileSync(name, 'utf8'))
  assert.doesNotMatch(output, /from ['"]\.\/dockCatalogTestKit['"]/)
  assert.match(output, /from ['"]\.\/localDockCatalogTestKit['"]/)
  assert.equal(isLocalClientSourcePath('client/src/spaces/canvas/dockCatalogTestKit.ts'), false)
  assert.equal(existsSync('local-edition/overrides/client/src/spaces/canvas/localDockCatalogTestKit.ts') || existsSync('client/src/spaces/canvas/localDockCatalogTestKit.ts'), true)
})

test('local price-summary tests stay independent of Cloud quote fixtures', () => {
  const source = readFileSync('client/src/spaces/canvas/generationReviewRows.test.ts', 'utf8')
  assert.match(source, /promptSummary/)
  assert.doesNotMatch(source, /cloudCatalogModel|approvePreparedGenerationQuotes/)
  assert.equal(isLocalClientSourcePath('client/src/spaces/canvas/cloudGenerationReviewRows.test.ts'), false)
})
