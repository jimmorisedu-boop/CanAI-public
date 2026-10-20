/**
 * Paths in this module are always repository relative POSIX paths.  The
 * release exporter calls this predicate before it reads a committed blob, so
 * returning false is what keeps a Cloud/network implementation out of the
 * generated local checkout.  Mixed entry points stay selected and are
 * rewritten by transformLocalClientSource below (or replaced by an overlay).
 */

const CLIENT_ROOT = 'client/'

// A local board and the local-host tablet do not need any of these modules.
// Keep the list explicit: a broad "contains network" rule would accidentally
// remove LAN tablet access and the normal request retry helpers.
const EXCLUDED_CLIENT_PATHS = Object.freeze([
  /^client\/public\/help\/cloud-boundary(?:-[^/]+)?\.(?:svg|png|jpe?g)$/iu,
  /^client\/src\/spaces\/canvas\/collaboration(?:\/|$)/iu,
  /^client\/src\/spaces\/canvas\/cloud[^/]*\.(?:[cm]?[jt]sx?|json|css)$/iu,
  /^client\/src\/spaces\/canvas\/agents\/cloud[^/]*\.(?:[cm]?[jt]sx?|json|css)$/iu,
  /^client\/src\/spaces\/canvas\/konva\/(?:BoardParticipants|Collaboration|boardFollow|cloud[^/]*)[^/]*\.(?:[cm]?[jt]sx?|json|css)$/iu,
  /^client\/src\/spaces\/canvas\/shares(?:\/|$)/iu,
  /^client\/src\/spaces\/canvas\/(?:AccountPublicationDialog|PersonalDraftIndicator)\.[^/]+$/iu,
  /^client\/src\/projects\/(?:Cloud[^/]*|cloud[^/]*|TeamLink[^/]*|teamLink[^/]*)\.[^/]+$/iu,
  /^client\/src\/projects\/(?:boardMembership|CopyBoardDialog|GallerySourceBadge)\.[^/]+$/iu,
  /^client\/src\/projects\/(?:CreateBoardDialog|galleryScalabilityUi)\.[^/]+$/iu,
  /^client\/src\/settings\/(?:Cloud[^/]*|cloud[^/]*|TeamAccount[^/]*|teamLink[^/]*)\.[^/]+$/iu,
  /^client\/src\/tablet\/(?:cloud[^/]*|Cloud[^/]*|TabletCloud[^/]*|standaloneCloud[^/]*|cloudBridge[^/]*|cloudPairing[^/]*|collaboration[^/]*|serviceWorkerRegistration)\.[^/]+$/iu,
  /^client\/src\/tablet\/(?:pairedRuntime|TabletAccountMenu|TabletGallery\.test)\.[^/]+$/iu,
  /^client\/src\/ui\/(?:Cloud[^/]*|cloud[^/]*|teamBudget)\.[^/]+$/iu,
  /^client\/src\/ui\/network\.test\.[^/]+$/iu,
  /^client\/src\/spaces\/canvas\/konva\/RemoteCursor\.[^/]+$/iu,
  /^client\/src\/spaces\/canvas\/(?:dockCatalogTestKit|personalDraftStatus\.test|quietReconnect\.test)\.[^/]+$/iu,
  // Cloud/team/collaboration modules are deliberately excluded by basename as
  // well as by their historical directories.  This catches additions such as
  // AgentCloudLaunchFields and CollaborationOverlay without matching the
  // ordinary local request/retry helpers or LAN tablet entrypoints.
  /^client\/src\/(?:[^/]*(?:cloud|collaborat|team)[^/]*)\.[^/]+$/iu,
  /^client\/src\/(?:.+\/)?(?:[^/]*(?:cloud|collaborat|team)[^/]*)\.[^/]+$/iu,
  /^client\/src\/(?:.+\/)?BoardParticipants[^/]*\.[^/]+$/iu,
])

/** Mixed files with a local-edition transform or a corresponding overlay. */
const MIXED_CLIENT_PATHS = new Set([
  'client/src/App.tsx',
  'client/src/api.ts',
  'client/src/types.ts',
  'client/src/spaces/canvas/macroEditBus.ts',
  'client/src/main.tsx',
  'client/src/help/content/guide.json',
  'client/src/projects/ProjectsScreen.tsx',
  'client/src/projects/galleryProjectList.ts',
  'client/src/tablet/main.tsx',
  'client/src/tablet/TabletApp.tsx',
  'client/src/tablet/TabletBoard.tsx',
  'client/src/tablet/TabletGallery.tsx',
  'client/src/tablet/TabletMacros.tsx',
  'client/src/tablet/TabletAssistantPresets.tsx',
  'client/src/tablet/TabletPrompt.tsx',
  'client/src/tablet/remoteSession.ts',
  'client/src/tablet/TabletSettings.tsx',
  'client/src/tablet/TabletOverlays.tsx',
  'client/src/tablet/TabletContextBar.tsx',
  'client/src/tablet/TabletItemMenu.tsx',
  'client/src/tablet/TabletInspector.tsx',
  'client/src/tablet/useTabletAssistantSelection.ts',
  'client/src/tablet/useTabletGeneration.ts',
  'client/src/tablet/runtime.ts',
  'client/src/spaces/canvas/CanvasSpace.tsx',
  'client/src/spaces/canvas/konva/boardUploader.ts',
  'client/src/spaces/canvas/macroRunClient.ts',
  'client/src/spaces/canvas/genOptions.ts',
  'client/src/spaces/canvas/PromptMacros.tsx',
  'client/src/spaces/canvas/useMacroLibraryData.ts',
  'client/src/spaces/canvas/AssistantPresets.tsx',
  'client/src/spaces/canvas/konva/pasteAdoption.ts',
  'client/src/spaces/canvas/konva/canvasStore.ts',
  'client/src/spaces/canvas/konva/importMedia.ts',
  'client/src/spaces/canvas/konva/KonvaCanvas.tsx',
  'client/src/spaces/canvas/konva/VideoItem.tsx',
  'client/src/spaces/canvas/konva/useCanvasAnchor.ts',
  'client/src/spaces/canvas/konva/zipExport.ts',
  'client/src/spaces/canvas/continuity/sessionDraftSync.ts',
  'client/src/spaces/canvas/generationRegistry.ts',
  'client/src/spaces/canvas/genOptions.ts',
  'client/src/spaces/canvas/AssistantPresets.tsx',
  'client/src/spaces/canvas/promptChatStore.ts',
  'client/src/spaces/canvas/assistantAsk.ts',
  'client/src/spaces/canvas/actionDockBatchPlanning.test.ts',
  'client/src/tablet/BoardCanvas.tsx',
  'client/src/tablet/boardHistory.tsx',
  'client/src/ui/TopbarActions.tsx',
  'client/src/styles.css',
  'client/src/styles/canvas-ui.css',
  'client/src/styles/gallery.css',
  'client/vite.tablet.config.ts',
  'client/package.json',
])

const FORBIDDEN_HELP_TOPIC = /(?:cloud|network[- ]board|team server|team account|shared board|guest link|collaborat|participants|sign in to network)/iu

function posix(value) {
  return String(value).replaceAll('\\', '/')
}

function validRelative(value) {
  const normalized = posix(value)
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) return false
  const parts = normalized.split('/')
  return parts.every((part) => part && part !== '.' && part !== '..')
}

function matchesExcluded(normalized) {
  return EXCLUDED_CLIENT_PATHS.some((pattern) => pattern.test(normalized))
}

/** Return true for a client source that belongs in the local-only edition. */
export function isLocalClientSourcePath(sourcePath) {
  const normalized = posix(sourcePath)
  if (!validRelative(normalized)) return false
  // The exporter asks this predicate about every repository path.  Client
  // policy only rejects excluded client blobs; server, package, docs, and root
  // paths are accepted here and are evaluated by their own policy modules.
  if (!normalized.startsWith(CLIENT_ROOT)) return true
  return !matchesExcluded(normalized)
}

function stripCloudImportLines(source) {
  const lines = source.split(/\r?\n/u)
  const output = []
  let pending = null
  const isImportOrReExport = (line) => /^[ \t]*(?:import(?:\s+type)?\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:type\s+)?(?:\{|\*\s+from\s+))/u.test(line)
  const finishesStatement = (line) => /(?:from\s*['"][^'"]+['"]|;)[ \t]*$/u.test(line)
  const forbidden = (text) => /(?:cloud|Cloud|collaboration|Collaboration|teamBudget|CloudComments|CloudBoardMembers)/u.test(text)
  for (const line of lines) {
    if (!pending) {
      if (!isImportOrReExport(line)) {
        output.push(line)
        continue
      }
      pending = [line]
      if (!finishesStatement(line)) continue
      if (!forbidden(pending.join('\n'))) output.push(...pending)
      pending = null
      continue
    }
    pending.push(line)
    if (!finishesStatement(line)) continue
    if (!forbidden(pending.join('\n'))) output.push(...pending)
    pending = null
  }
  if (pending && !forbidden(pending.join('\n'))) output.push(...pending)
  return output.join('\n')
}

function stripCloudCssImports(source) {
  return source
    .split(/\r?\n/u)
    .filter((line) => !/@import[^;]*(?:board-participants|cloud|collaboration)/iu.test(line))
    .join('\n')
}

function stripTabletCollaboration(source) {
  let output = source
    .replace(/^[ \t]*import \{ useCollaborationVersion \} from ['"]\.\.\/spaces\/canvas\/konva\/useStore['"];?\r?\n/gu, '')
    .replace(/^[ \t]*import \{ useCollaborationVersion, useContentVersion \} from ['"]\.\.\/spaces\/canvas\/konva\/useStore['"];?\r?\n/gu, "import { useContentVersion } from '../spaces/canvas/konva/useStore'\n")
    .replace(/^[ \t]*import \{ collaborationActionBlocked, collaborationBlockReason \} from ['"]\.\/collaborationUi['"];?\r?\n/gu, '')
    .replace(/^[ \t]*import \{ collaborationActionBlocked, collaborationBlockReason \} from ['"]\.\/collaborationUi\.js['"];?\r?\n/gu, '')
    .replace(/^[ \t]*useCollaborationVersion\(store\)[ \t]*;?[ \t]*\r?\n/gmu, '')
    .replace(/collaborationActionBlocked\([^\n]*?\)/gu, 'false')
    .replace(/collaborationBlockReason\([^\n]*?\)/gu, "''")
  return output
}

function removeBalancedBlock(source, marker) {
  const start = source.search(marker)
  if (start < 0) return source
  const open = source.indexOf('{', start)
  if (open < 0) return source
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) { if (char === '\n') lineComment = false; continue }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1 }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (char === '`' || char === '"' || char === "'") { quote = char; continue }
    if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) {
      let end = index + 1
      while (source[end] === '\r' || source[end] === '\n' || source[end] === ';') end += 1
      return `${source.slice(0, start)}${source.slice(end)}`
    }
  }
  return source
}

/** Remove a call whose first argument is a balanced block (for example useEffect). */
function removeBalancedCall(source, marker) {
  const start = source.search(marker)
  if (start < 0) return source
  const open = source.indexOf('{', start)
  if (open < 0) return source
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  let close = -1
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) { if (char === '\n') lineComment = false; continue }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1 } continue }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (char === '`' || char === '"' || char === "'") { quote = char; continue }
    if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) { close = index + 1; break }
  }
  if (close < 0) return source
  let end = close
  while (/\s/u.test(source[end] ?? '')) end += 1
  if (source[end] === ',') {
    end += 1
    let parenDepth = 0
    let bracketDepth = 0
    let innerQuote = null
    let innerEscaped = false
    for (; end < source.length; end += 1) {
      const char = source[end]
      if (innerQuote) {
        if (innerEscaped) innerEscaped = false
        else if (char === '\\') innerEscaped = true
        else if (char === innerQuote) innerQuote = null
        continue
      }
      if (char === '`' || char === '"' || char === "'") { innerQuote = char; continue }
      if (char === '(') parenDepth += 1
      else if (char === ')') {
        if (parenDepth === 0 && bracketDepth === 0) { end += 1; break }
        parenDepth -= 1
      } else if (char === '[') bracketDepth += 1
      else if (char === ']') bracketDepth -= 1
    }
  } else if (source[end] === ')') end += 1
  while (source[end] === '\r' || source[end] === '\n' || source[end] === ';') end += 1
  return `${source.slice(0, start)}${source.slice(end)}`
}

function apiPropertyPositions(source) {
  const objectStart = source.indexOf('export const api = {')
  if (objectStart < 0) return []
  const open = source.indexOf('{', objectStart)
  const positions = []
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) { if (char === '\n') lineComment = false; continue }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1 } continue }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (char === '`' || char === '"' || char === "'") { quote = char; continue }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 1 && (index === 0 || source[index - 1] === '\n')) {
      const match = /^  ([A-Za-z][A-Za-z0-9_]*)\s*(?::|\()/u.exec(source.slice(index))
      if (match) positions.push({ name: match[1], start: index })
    }
    if (depth === 0 && index > open) break
  }
  return positions
}

function removeApiProperties(source, names) {
  const wanted = new Set(names)
  const positions = apiPropertyPositions(source)
  if (positions.length === 0) return source
  const removals = []
  for (let index = 0; index < positions.length; index += 1) {
    const current = positions[index]
    if (!wanted.has(current.name)) continue
    const end = positions[index + 1]?.start ?? source.lastIndexOf('}')
    removals.push([current.start, end])
  }
  let output = source
  for (const [start, end] of removals.reverse()) output = `${output.slice(0, start)}${output.slice(end)}`
  return output
}

function transformApiSource(source) {
  let output = source
    .replace(/^[ \t]*import \{ localCopyForCloudReveal \} from ['"]\.\/spaces\/canvas\/cloudExternalEdit['"];?\r?\n/gmu, '')
    .replace(/\bboardSource\?: 'local' \| 'cloud'/gu, "boardSource?: 'local'")
    .replace(/\bboardSource\?: 'cloud'/gu, "boardSource?: 'local'")
    .replace(/const cloudPromptBase[\s\S]*?export const cloudPromptChatApi = \{/u, 'export const cloudPromptChatApi = {')
  output = removeBalancedBlock(output, /export const cloudPromptChatApi = \{/u)
  output = output.replace(/function mediaToolUrl\(src: string, tool: string\): string \{[\s\S]*?\n\}/u, "function mediaToolUrl(_src: string, tool: string): string { return `/api/media/${tool}` }")
  output = output.replace(/const cloudTarget = target\?\.projectRef\.source === 'cloud'[\s\S]*?const submitOptions = cloudTarget\n      \? \{ \[\.\.\.\(options \?\? \{\}\), idempotencyKey \} : options/u, "const cloudTarget = false\n    const idempotencyKey = options?.idempotencyKey\n    const submitOptions = options")
  output = output.replace(/\s*if \(!\(error instanceof ApiError\)[\s\S]*?return post<\{ jobId: string \}>\('\/api\/generate',[\s\S]*?\n    \}\n  \},/u, '\n    }\n  },')
  output = removeApiProperties(output, [
    'cloudTabletPairing', 'startCloudTabletPairing', 'stopCloudTabletPairing',
    'loadCloudSessionDraft', 'saveCloudSessionDraft',
    'cloudAccount', 'cloudJournalScope', 'cloudRoute', 'checkCloudRoute', 'setCloudProxy',
    'loginCloudAccount', 'changeCloudPassword', 'requestCloudPasswordReset', 'logoutCloudAccount',
    'cloudAccountProjects', 'cloudAccountCachedProjects', 'cloudAccountModels',
    'cloudMirrorStatus', 'cloudMirrorBoards', 'cloudMirrorSync', 'cloudMirrorSetEnabled', 'cloudMirrorDelete', 'cloudMirrorReveal', 'cloudMirrorCopyLocal',
    'createCloudProject', 'archivedCloudProjects', 'renameCloudProject', 'setCloudProjectArchived', 'copyCloudProjectToLocal',
    'cloudProjectComments', 'cloudProjectMembers', 'cloudBoardTeamMembers', 'setCloudBoardMemberAccess', 'removeCloudBoardMember', 'createCloudProjectComment', 'updateCloudProjectComment', 'deleteCloudProjectComment',
    'personalDraftStatus', 'setPersonalBackupEnabled', 'flushPersonalDraft', 'importPersonalBoard', 'copyPersonalBoard',
    'listAccountPublications', 'createAccountPublication', 'publishAccountRevision', 'updateAccountPublication', 'rotateAccountPublication', 'accountPublicationDiscussion', 'markAccountPublicationRead', 'replyToAccountPublication', 'resolveAccountPublicationThread',
    'listCloudAssistants', 'createCloudAssistant', 'updateCloudAssistant', 'selectCloudAssistant', 'copyCloudAssistant', 'submitCloudAssistant', 'deleteCloudAssistant', 'shareCloudAssistant',
    'listCloudMacros', 'createCloudMacro', 'updateCloudMacro', 'copyCloudMacro', 'submitCloudMacro', 'deleteCloudMacro', 'shareCloudMacro', 'cloudMacroPlan', 'cloudMacroQuote', 'startCloudMacroRun', 'listCloudMacroRuns', 'cancelCloudMacroRun',
    'warmCloudAsset', 'reserveCloudExportNumbers',
  ])
  output = output.replace(/  generate: async \([\s\S]*?\n  quoteGeneration:/u, `  generate: async (
    kind: JobKind,
    prompt: string,
    refs: GenRef[],
    model?: string,
    params?: Record<string, unknown>,
    target?: GenerationTarget,
    options?: GenerationSubmitOptions,
  ): Promise<{ jobId: string }> => post<{ jobId: string }>('/api/generate', {
    kind, prompt, refs, model, params, target, ...(options ?? {}),
  }),

  quoteGeneration:`)
  output = output.replace(/  revealFile: async \(src: string\) => \{\r?\n    const localSrc = await localCopyForCloudReveal\(src\)\r?\n    return post<\{ ok: boolean \}>\('\/api\/media\/reveal', \{ src: localSrc \}\)\r?\n  \},/u,
    `  revealFile: async (src: string) => {
    if (!src.startsWith('/media/')) throw new Error('Invalid local media path.')
    return post<{ ok: boolean }>('/api/media/reveal', { src })
  },`)
  output = output.replace(/\bcloudPromptChatApi\b/gu, 'promptChatApiRemoved')
    .replace(/localCopyForCloudReveal\(src\)/gu, 'src')
    .replace(/\/api\/cloud-assets\/[A-Za-z0-9_?${}\/.-]*/gu, '/api/media')
  return output
}

function transformTypesSource(source) {
  // Keep the historical type surface for shared modules that are compiled in
  // the local checkout. These declarations are type-only compatibility data;
  // every Cloud/network implementation and route is filtered or overlaid.
  return source
}

function transformTabletSource(normalized, source) {
  let output = source
  if (['client/src/tablet/TabletContextBar.tsx', 'client/src/tablet/TabletItemMenu.tsx', 'client/src/tablet/TabletInspector.tsx'].includes(normalized)) {
    output = stripTabletCollaboration(output)
    if (normalized === 'client/src/tablet/TabletInspector.tsx' && !/import \{ useContentVersion \}/u.test(output)) {
      output = "import { useContentVersion } from '../spaces/canvas/konva/useStore'\n" + output
    }
  }
  if (normalized === 'client/src/tablet/TabletBoard.tsx') {
    output = output
      .replace(/runtime\.kind !== 'lan' && runtime\.kind !== 'paired'/gu, "runtime.kind !== 'lan'")
      .replace(/runtime\.kind !== 'lan' \|\| runtime\.kind !== 'paired'/gu, "runtime.kind !== 'lan'")
      .replace(/runtime\.kind === 'cloud'/gu, 'false')
      .replace(/runtime\.kind !== 'cloud'/gu, 'true')
      .replace(/'cloud'/gu, "'local'")
      .replace(/\bCloud\b/gu, 'Local')
      .replace(/\bcloud\b/gu, 'local')
    output = removeBalancedCall(output, /useEffect\(\(\) => \{\s*store\.setCollaboration\(/u)
  }
  if (normalized === 'client/src/tablet/TabletPrompt.tsx') {
    output = output
      .replace(/if \(projectSource !== 'cloud'\) return/gu, 'if (true) return')
      .replace(/isStandaloneCloudTablet: projectSource === 'cloud'/gu, 'isStandaloneCloudTablet: false')
      .replace(/projectSource === 'cloud'/gu, 'false')
      .replace(/projectSource !== 'cloud'/gu, 'true')
      .replace(/\bCloud\b/gu, 'Local')
      .replace(/\bcloud\b/gu, 'local')
      .replace(/The team server did not confirm board memory support\./gu, 'The Host did not confirm board memory support.')
  }
  if (normalized === 'client/src/tablet/useTabletGeneration.ts') {
    output = output
      .replace(/projectSource === 'cloud'/gu, 'false')
      .replace(/\bCloud\b/gu, 'Local')
      .replace(/\bcloud\b/gu, 'local')
  }
  if (normalized === 'client/src/tablet/TabletPrompt.tsx') {
    output = output
      .replace(/onChanged\s*:\s*\(\) => \{\s*if \(true\) return[\s\S]*?\s*\},/gu, 'onChanged: () => {},')
      .replace(/onChanged=\{\(\) => \{\s*if \(true\) return[\s\S]*?\s*\}\}/gu, 'onChanged={() => {}}')
  }
  return output
}

function transformCanvasStoreSource(source) {
  let output = source
    .replace(/import type \{ BoardCollaborationPort \} from ['"]\.\.\/collaboration\/types['"]\r?\n/u, `type BoardCollaborationPort = {
  subscribe(listener: () => void): () => void
  getSnapshot(): { locks: Array<{ objectId: string }> }
  requestSelection(ids: readonly string[]): Promise<boolean>
  canMutate(ids: readonly string[]): boolean
  looksMutable?(ids: readonly string[]): boolean
  withSelection(ids: readonly string[], work: () => void | Promise<void>): Promise<boolean>
  setPreview(items: readonly unknown[] | null): void
  setCursor(point: { x: number; y: number } | null): void
  setVisible?(visible: boolean): void
  heldObjectIds?(): ReadonlySet<string>
}
`)
    // Local generation results already carry their dimensions or are probed
    // from the file. The remote asset-size shortcut is intentionally absent.
    .replace(/    const cloudImageSize = !isVideo[\s\S]*?      : null\r?\n/u, '')
    .replace(/    \} else if \(cloudImageSize\) \{\r?\n      size = cloudImageSize\r?\n    \} else \{/u, '    } else {')
    .replace(/    if \(completed && cloudImageSize\) \{[\s\S]*?\r?\n    \}\r?\n/u, '')
  return output
}

function transformImportMediaSource(source) {
  let output = source
    .replace(/import \{ uploadCloudAsset \} from ['"]\.\.\/cloudAssetTransport['"]\r?\n/u, '')
    .replace(/  const uploadPendingIds = projectRef\?\.source === 'cloud'[\s\S]*?\r?\n    : \[\]\r?\n/u, '  const uploadPendingIds: Array<string | undefined> = []\n')
    .replace(/      if \(projectRef\?\.source === 'cloud' && !store\.getPending\(\)\.some\(\(item\) => item\.id === uploadPendingIds\[index\]\)\) \{[\s\S]*?\r?\n      \}\r?\n/u, '')
    .replace(/        const uploaded = uploader\r?\n          \? await uploader\(file, uploadSignal, reportProgress\)\r?\n          : projectRef\?\.source === 'cloud'\r?\n          \? await uploadCloudAsset\([^\n]+\)\r?\n          : await api\.uploadFile\(file, uploadSignal, reportProgress\)/u, '        const uploaded = uploader\n          ? await uploader(file, uploadSignal, reportProgress)\n          : await api.uploadFile(file, uploadSignal, reportProgress)')
  return output
}

function transformKonvaCanvasSource(source) {
  let output = source
    .replace(/import \{ prewarmList, prewarmSignature, sendPrewarm \} from ['"]\.\/cloudPreviewPrewarm['"]\r?\n/u,
      "const prewarmList = (..._args: unknown[]) => [] as unknown[]\nconst prewarmSignature = (..._args: unknown[]) => ''\nconst sendPrewarm = (_entries: unknown[]) => {}\n")
    .replace(/import \{ publishAnnotationCamera \} from ['"]\.\.\/shares\/annotationCameraBus['"]\r?\n/u,
      'const publishAnnotationCamera = (_camera: unknown) => {}\n')
    .replace(/import \{ publishBoardMarquee \} from ['"]\.\.\/shares\/boardMarqueeBus['"]\r?\n/u,
      'const publishBoardMarquee = (_rect: unknown) => {}\n')
    .replace(/import \{ CollaborationOverlay \} from ['"]\.\/CollaborationOverlay['"]\r?\n/u, '')
    .replace(/import \{ BoardParticipantsMenu \} from ['"]\.\/BoardParticipantsMenu['"]\r?\n/u, '')
    .replace(/import \{ useBoardFollow \} from ['"]\.\/boardFollow['"]\r?\n/u,
      'const useBoardFollow = (_store: unknown, _size: unknown, _visible?: unknown) => ({ publishCamera: (_camera: unknown) => {}, resizeViewport: (_size: unknown) => {} })\n')
    .replace(/  const participantsPortal = usePortalTarget\('top-bar-participants-portal'\)\r?\n/u, '')
    .replace(/\r?\n\s*<CollaborationOverlay\b[^>]*\/>/gu, '')
    .replace(/\r?\n      \{visible && participantsPortal && createPortal\([\s\S]*?\n      \)\}/u, '')
    .replace(/function publishCanvasCursor\(point: \{ x: number; y: number \} \| null\): void \{[\s\S]*?\r?\n  \}/u,
      'function publishCanvasCursor(_point: { x: number; y: number } | null): void {}')
  return output
}

function transformVideoItemSource(source) {
  return source
    .replace(/import \{ cloudVideoWarmer \} from ['"]\.\/cloudVideoWarm['"]\r?\n/u, '')
    .replace(/import \{ api \} from ['"]\.\.\/\.\.\/\.\.\/api['"]\r?\n/u, '')
    .replace(/const warmCloudVideo = cloudVideoWarmer\(\(assetId\) => api\.warmCloudAsset\(assetId\)\)/u,
      'const warmCloudVideo = (_src?: string): void => {}')
}

function transformAnchorSource(source) {
  return source.replace(/import \{ subscribeAnnotationCamera \} from ['"]\.\.\/shares\/annotationCameraBus['"]\r?\n/u,
    'const subscribeAnnotationCamera = (_listener: (camera: { x: number; y: number; scale: number }) => void): (() => void) => () => {}\n')
}

function transformZipExportSource(source) {
  return source
    .replace(/cloud: ExportNumberProvider = api\.reserveCloudExportNumbers/u, 'cloud: ExportNumberProvider = api.reserveExportNumbers')
    .replace(/  return project\.source === 'cloud'\r?\n    \? cloud\(project\.id, groups\)\r?\n    : local\(project\.id, groups\)/u,
      '  return local(project.id, groups)')
}

function transformSessionDraftSyncSource(source) {
  return source
    .replace(/    const save = next\.source === 'cloud' \? api\.saveCloudSessionDraft : api\.saveSessionDraft/u,
      '    const save = api.saveSessionDraft')
    .replace(/    const answer = source === 'cloud'\r?\n      \? await api\.loadCloudSessionDraft\(projectId\)\r?\n      : await api\.loadSessionDraft\(projectId\)/u,
      '    const answer = await api.loadSessionDraft(projectId)')
}

function transformGenerationRegistrySource(source) {
  let output = source
    .replace(/import \{ notifyCloudJobBinding \} from ['"]\.\/cloudJobBinding['"]\r?\n/u, '')
    .replace(/  function announceCloudJob\(item: Tracked\): void \{[\s\S]*?\r?\n  \}\r?\n/u, '  function announceCloudJob(_item: Tracked): void {}\n')
    .replace(/let cloudJobTransport: CloudGenerationJobTransport \| null = null[\s\S]*?function isDirectCloudJob\(id: string\): boolean \{[\s\S]*?\r?\n\}\r?\n/u, '')
    .replace(/  getJob: \(id\) => cloudJobTransport && isDirectCloudJob\(id\)\r?\n    \? cloudJobTransport\.getJob\(id\) : api\.job\(id\),[\s\S]*?  cancelJob: \(id\) => cloudJobTransport && isDirectCloudJob\(id\)\r?\n    \? cloudJobTransport\.cancelJob\(id\) : api\.cancelJob\(id\),/u,
      '  getJob: (id) => api.job(id),\n  waitJobs: (ids, seen, signal) => api.waitJobs(ids, seen, signal),\n  cancelJob: (id) => api.cancelJob(id),')
  return output
}

function transformGenOptionsSource(source) {
  return source
    .replace(/import \{ cloudCatalogModels \} from ['"]\.\/cloudCatalogModel['"]\r?\n/u, '')
    .replace(/\(projectSource === 'cloud' \? api\.cloudAccountModels\(\) : api\.models\(\)\)/u, '(api.models())')
    .replace(/const models = projectSource === 'cloud' \? cloudCatalogModels\(r\.models\) : r\.models/u, 'const models = r.models')
}

function transformAssistantPresetsSource(source) {
  return source
    .replace(/import \{ CloudAssistantProfiles \} from ['"]\.\/CloudAssistantProfiles['"]\r?\n/u, '')
    .replace(/  if \(projectSource === 'cloud'\) return <CloudAssistantProfiles[\s\S]*?\n  return <LocalAssistantPresets/u, '  return <LocalAssistantPresets')
}

function transformPromptChatStoreSource(source) {
  return source
    .replace(/import \{ api, ApiError, cloudPromptChatApi \} from ['"]\.\.\/\.\.\/api['"]/u, "import { api, ApiError } from '../../api'")
    .replace(/import type \{ PromptChatHttpTransport \} from ['"]\.\/promptChatTransport['"]\r?\n/u, '')
    .replace(/let cloudTransportOverride: PromptChatHttpTransport \| null = null[\s\S]*?const promptTransport = createPromptChatTransport\(api, \(\) => cloudTransportOverride \?\? cloudPromptChatApi\)/u,
      'export function setBrowserCloudPromptChatTransport(_next: unknown): void {}\n\nconst promptTransport = createPromptChatTransport(api, api)')
}

function transformAssistantAskSource(source) {
  return source
    .replace(/^import \{ assistantRefsFor, assistantRefsNeedFrames \} from ['"]\.\/assistantCloudRefs['"]\r?\n/mu, '')
    .replace(/^import \{ dismissToast, notify \} from ['"]\.\/toastBus['"]\r?\n/mu, '')
    .replace(/^const FRAME_NOTICE = 'assistant-video-frame'\r?\n/mu, '')
    // Keep the frozen target conversation and original references in the local edition.
    .replace(/  \/\/ сетевой доске вместо ролика[^\n]*\r?\n  const framing = assistantRefsNeedFrames\(projectId, frozen\)[\s\S]*?    if \(framing\) dismissToast\(FRAME_NOTICE\)\r?\n  \}/u, '  const prepared = frozen')
}

function transformBoardCanvasSource(source) {
  return source
    .replace(/import \{ CollaborationOverlay \} from ['"]\.\.\/spaces\/canvas\/konva\/CollaborationOverlay['"]\r?\n/u, '')
    .replace(/import \{ BoardParticipantsMenu \} from ['"]\.\.\/spaces\/canvas\/konva\/BoardParticipantsMenu['"]\r?\n/u, '')
    .replace(/import \{ useBoardFollow \} from ['"]\.\.\/spaces\/canvas\/konva\/boardFollow['"]\r?\n/u,
      'const useBoardFollow = (_store: unknown, _viewport: unknown) => ({ resizeViewport: (_size: unknown) => {} })\n')
    .replace(/  const participantsPortal = usePortalTarget\('top-bar-participants-portal'\)\r?\n/u, '')
    .replace(/\r?\n\s*<CollaborationOverlay\b[^>]*\/>/gu, '')
    .replace(/\r?\n\s*\{participantsPortal && createPortal\([\s\S]*?\n\s*\)\}/u, '')
}

function transformBoardHistorySource(source) {
  return source
    .replace(/kind === 'cloud'/gu, 'false')
    .replace(/kind !== 'cloud'/gu, 'true')
}

function scrubHelpString(value) {
  let text = String(value)
  // Remove complete sentences that describe the disabled transport.  Keeping
  // surrounding prose is preferable to dropping a useful local topic.
  text = text.replace(/[^.!?\n]*(?:CanAI Cloud|network[- ]board|team server|team account|shared board|guest link|collaborat(?:ion|e|ive)|participants)[^.!?\n]*[.!?]/giu, ' ')
  text = text
    .replace(/\bCloud-only\b/giu, 'This edition')
    .replace(/\bCloud\b/giu, 'local')
    .replace(/\bteam server\b/giu, 'local app')
    .replace(/\bnetwork boards?\b/giu, 'local boards')
    .replace(/\bshared boards?\b/giu, 'local boards')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  return text
}

function sanitizeHelpValue(value) {
  if (typeof value === 'string') {
    const next = scrubHelpString(value)
    return next || undefined
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeHelpValue).filter((item) => item !== undefined)
  }
  if (!value || typeof value !== 'object') return value
  const next = {}
  for (const [key, child] of Object.entries(value)) {
    // IDs are joined after filtering. Do not rewrite a relation such as
    // `cloud-boundary` into a new (and misleading) local topic id.
    if (key === 'related') {
      next[key] = Array.isArray(child) ? [...child] : child
      continue
    }
    const sanitized = sanitizeHelpValue(child)
    if (sanitized !== undefined && !(key === 'id' && typeof sanitized === 'string' && FORBIDDEN_HELP_TOPIC.test(sanitized))) {
      next[key] = sanitized
    }
  }
  return next
}

function localizeNavigationTopic(topic) {
  const rewrite = (value) => {
    if (typeof value === 'string') {
      return value
        .replace(/find a teammate/giu, 'move around the board')
        .replace(/Choose a name to visit their cursor, or Follow to move with their board view and zoom\. Pan or zoom yourself to stop following\./giu, 'Use the Board map to move around the Canvas.')
        .replace(/Open the participants icon to visit or follow a teammate; pan or zoom to stop following/giu, 'Use the Board map to move around the Canvas')
        .replace(/Choosing a name moves your view once and keeps your selection\. Follow shares their view until you pan, zoom, press Stop, or they leave\. Follow is available when their device shares its board view\./giu, 'The Board map moves your view while keeping the current selection.')
    }
    if (Array.isArray(value)) return value.map(rewrite)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]))
  }
  return rewrite(topic)
}

function transformHelpGuide(source) {
  try {
    const guide = JSON.parse(source)
    const topics = Array.isArray(guide.topics)
      ? guide.topics
        .filter((topic) => topic && typeof topic === 'object')
        .filter((topic) => !FORBIDDEN_HELP_TOPIC.test(String(topic.id ?? '')))
        .map(sanitizeHelpValue)
        .map((topic) => topic?.id === 'navigation-shortcuts' ? localizeNavigationTopic(topic) : topic)
        .filter((topic) => topic && typeof topic === 'object' && typeof topic.id === 'string')
      : []
    const ids = new Set(topics.map((topic) => topic.id).filter((id) => typeof id === 'string'))
    for (const topic of topics) {
      if (Array.isArray(topic.related)) topic.related = topic.related.filter((id) => ids.has(id))
    }
    const categories = Array.isArray(guide.categories)
      ? guide.categories.filter((category) => topics.some((topic) => topic.category === category.id))
      : []
    return `${JSON.stringify({ ...guide, categories, topics }, null, 2)}\n`
  } catch {
    // A malformed guide should still be passed through so the normal Help
    // checker reports the real JSON diagnostic instead of hiding it here.
    return source
  }
}

function transformClientPackage(source) {
  try {
    const pkg = JSON.parse(source)
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const key of Object.keys(pkg.scripts)) {
        if (/cloud|network|collab/iu.test(key)) {
          delete pkg.scripts[key]
          continue
        }
        if (typeof pkg.scripts[key] === 'string') {
          const commands = pkg.scripts[key]
            .split(/\s*&&\s*/u)
            .map((command) => {
              // Test/build scripts commonly list Cloud files inside an
              // otherwise local command (for example pretest).  Remove those
              // file arguments by applying the same path predicate used by
              // the exporter, then drop a command that has no input left.
              const filtered = command.replace(/(?:^|\s)(\.\/)?(?:src|client\/src)\/[^\s'"`]+\.(?:[cm]?[jt]sx?|json|css)(?=\s|$)/giu, (token) => {
                const raw = token.trim().replace(/^\.\//u, '')
                const candidate = raw.startsWith('client/') ? raw : `client/${raw}`
                return isLocalClientSourcePath(candidate) ? token : ''
              }).replace(/\s{2,}/gu, ' ').trim()
              if (/\b(?:tsx|vitest|jest)\b/iu.test(filtered)
                && /--test\b/iu.test(filtered)
                && !/(?:src|client\/src)\/[^\s'"`]+\.(?:[cm]?[jt]sx?|json|css)/iu.test(filtered)) return ''
              return filtered
            })
            .filter(Boolean)
          pkg.scripts[key] = commands.join(' && ')
            .replace(/\s*&&\s*npm run build:tablet:cloud/iu, '')
            .replace(/\s*&&\s*npm run [^ ]*cloud[^ ]*/iu, '')
        }
      }
      if (typeof pkg.scripts.build === 'string') pkg.scripts.build = pkg.scripts.build.replace(/\s*&&\s*npm run build:tablet:cloud/iu, '')
    }
    return `${JSON.stringify(pkg, null, 2)}\n`
  } catch {
    return source
  }
}

/**
 * Transform a selected mixed client source file.  Unrelated paths are returned
 * byte-for-byte; the exporter can therefore safely call this for every blob.
 */
export function transformLocalClientSource(sourcePath, sourceText) {
  const normalized = posix(sourcePath)
  if (!MIXED_CLIENT_PATHS.has(normalized)) return sourceText
  if (normalized === 'client/src/help/content/guide.json') return transformHelpGuide(sourceText)
  if (normalized === 'client/package.json') return transformClientPackage(sourceText)
  if (normalized === 'client/src/api.ts') return transformApiSource(sourceText)
  if (normalized === 'client/src/types.ts') return transformTypesSource(sourceText)
  if (normalized === 'client/src/styles.css') return stripCloudCssImports(sourceText)
  if (/\.css$/iu.test(normalized)) return stripCloudCssImports(stripCloudImportLines(sourceText))
  if (normalized === 'client/src/spaces/canvas/konva/canvasStore.ts') return transformCanvasStoreSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/konva/importMedia.ts') return transformImportMediaSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/konva/KonvaCanvas.tsx') return transformKonvaCanvasSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/konva/VideoItem.tsx') return transformVideoItemSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/konva/useCanvasAnchor.ts') return transformAnchorSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/konva/zipExport.ts') return transformZipExportSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/continuity/sessionDraftSync.ts') return transformSessionDraftSyncSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/generationRegistry.ts') return transformGenerationRegistrySource(sourceText)
  if (normalized === 'client/src/spaces/canvas/genOptions.ts') return transformGenOptionsSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/AssistantPresets.tsx') return transformAssistantPresetsSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/promptChatStore.ts') return transformPromptChatStoreSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/assistantAsk.ts') return transformAssistantAskSource(sourceText)
  if (normalized === 'client/src/spaces/canvas/actionDockBatchPlanning.test.ts') {
    return sourceText.replace(/from ['"]\.\/dockCatalogTestKit['"]/u, "from './localDockCatalogTestKit'")
  }
  if (normalized === 'client/src/tablet/BoardCanvas.tsx') return transformBoardCanvasSource(sourceText)
  if (normalized === 'client/src/tablet/boardHistory.tsx') return transformBoardHistorySource(sourceText)
  if (normalized === 'client/src/ui/TopbarActions.tsx') return sourceText
  // Import lines are safe to remove before an overlay replaces the entrypoint;
  // they also prevent a stale Cloud-only module from re-entering the graph when
  // a future shared entrypoint adds a harmless local branch.
  return transformTabletSource(normalized, stripCloudImportLines(sourceText))
}

export const LOCAL_CLIENT_EXCLUDED_PATHS = EXCLUDED_CLIENT_PATHS
export const LOCAL_CLIENT_MIXED_PATHS = MIXED_CLIENT_PATHS
