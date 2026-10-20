import crypto, { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentPackageCheckRequest, AgentPackageCheckView, AgentPackageTrustView } from '../../../packages/agent-protocol/index.js'
import { AgentPackageError } from './package-errors.js'
import { extractPackageArchive } from './package-archive.js'
import { checkPackage, supportedPackage, type CheckedPackage } from './package-check.js'
import { AgentPackageLibrary } from './library.js'
import { canonicalGitSource, type ArchivePackageSource, type GitPackageSource, type GitSourceTransport } from './package-source.js'
import { AgentPackageUploadStore } from './package-upload.js'
import type { PackageSourceView } from './packages.js'
import { archiveSourceView, sourceView, TRUST_DISCLAIMER } from './package-manager-support.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/u

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new AgentPackageError('REQUEST_INVALID', `${label} is invalid`)
  return value
}

export interface PackageManagerCheckOptions {
  library: AgentPackageLibrary
  source: GitSourceTransport
  stagingRoot: string
  uploads?: AgentPackageUploadStore
  checkWithRuntime: (root: string) => Promise<CheckedPackage>
}

export async function checkPackageSource(input: AgentPackageCheckRequest, options: PackageManagerCheckOptions): Promise<AgentPackageCheckView> {
  return options.library.serialized(async () => {
    const sourceInput: GitPackageSource | ArchivePackageSource = input.source
    const source = sourceInput.kind === 'archive' ? sourceInput : canonicalGitSource(sourceInput)
    const requestId = id(input.requestId, 'requestId')
    const fingerprint = AgentPackageLibrary.fingerprint({ action: 'check', source })
    const document = options.library.snapshot()
    const prior = document.requests[requestId]
    if (prior) {
      if (prior.action !== 'check' || prior.fingerprint !== fingerprint) throw new AgentPackageError('REQUEST_REUSE', 'requestId was already used for another check', 409)
      return prior.response as AgentPackageCheckView
    }
    let archive: Buffer
    let sourceRecord: PackageSourceView
    let subdir: string | undefined
    if (source.kind === 'archive') {
      if (!options.uploads) throw new AgentPackageError('PACKAGE_MANAGER_UNAVAILABLE', 'ZIP upload storage is unavailable', 503)
      const uploaded = await options.uploads.read(source.archiveId)
      archive = uploaded.bytes
      subdir = source.subdir
      sourceRecord = archiveSourceView({ archiveId: uploaded.metadata.archiveId, archiveSha: uploaded.metadata.archiveSha, subdir, provenance: uploaded.metadata.provenance as Record<string, string> | undefined })
    } else {
      if (sourceInput.kind !== 'git') throw new AgentPackageError('SOURCE_UNSUPPORTED', 'Package source is invalid', 400)
      const resolved = await options.source.resolve(sourceInput)
      archive = await options.source.download(resolved)
      subdir = resolved.subdir
      sourceRecord = sourceView(resolved)
    }
    const checkId = `check-${randomUUID()}`
    const staging = path.resolve(options.stagingRoot, checkId)
    let checked: CheckedPackage
    try {
      await extractPackageArchive(archive, staging, subdir)
      checked = await options.checkWithRuntime(staging)
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    const resultBase = {
      checkId,
      source: sourceRecord,
      manifest: checked.manifestView,
      packageSha: checked.packageSha,
      supported: supportedPackage(checked),
      issues: checked.issues,
      trust: { explicitTrustRequired: true as const, requiredPermissions: [...checked.manifest.permissions], disclaimer: TRUST_DISCLAIMER } satisfies AgentPackageTrustView,
    }
    const committed = await options.library.transactionUnlocked(undefined, (draft, revision) => {
      const result = { ...resultBase, revision }
      draft.checks[checkId] = { ...result, stagingRelative: `agents/staging/${checkId}`, archiveSha: crypto.createHash('sha256').update(archive).digest('hex'), treeSha: checked.packageSha, createdAt: Date.now() }
      draft.requests[requestId] = { action: 'check', fingerprint, response: result, createdAt: Date.now() }
      return result
    })
    return committed.value
  })
}
