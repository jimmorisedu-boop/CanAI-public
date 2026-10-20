import path from 'node:path'
import { AgentPackageError } from './package-errors.js'
import { checkPackage, type RuntimeMetadata } from './package-check.js'
import type { ResolvedGitSource } from './package-source.js'
import { pythonLaunch, type PythonRuntimeMetadata } from './package-runtime.js'
import type { PackageRuntimePin, PackageSourceView } from './packages.js'

export const TRUST_DISCLAIMER = 'The package runs as a regular user process without an OS sandbox; Host permissions limit broker tools only, not arbitrary Node/Python code or network access.'
type VerifiedPythonRuntime = PythonRuntimeMetadata & { archiveSha: string }

export function packageRoot(root: string, idValue: string): string { return path.resolve(root, idValue) }

export function sourceView(source: ResolvedGitSource): PackageSourceView {
  return { kind: 'git', canonicalUrl: source.canonicalUrl, requestedRef: source.requestedRef, resolvedSha: source.resolvedSha, ...(source.subdir ? { subdir: source.subdir } : {}) }
}

export function archiveSourceView(source: { archiveId: string; archiveSha: string; subdir?: string; provenance?: Record<string, string> }): PackageSourceView {
  return { kind: 'archive', archiveId: source.archiveId, archiveSha: source.archiveSha, ...(source.subdir ? { subdir: source.subdir } : {}), ...(source.provenance ? { provenance: source.provenance } : {}) }
}

export function sourceIdentity(source: PackageSourceView): string {
  return source.kind === 'archive'
    ? `archive:${source.archiveId}:${source.subdir ?? ''}`
    : `git:${source.canonicalUrl}:${source.subdir ?? ''}`
}

export function sameRuntimePin(left: RuntimeMetadata | PythonRuntimeMetadata, right: PackageRuntimePin): boolean {
  const leftKind = left.kind ?? 'node'
  if (leftKind !== right.kind) return false
  if (left.version !== right.version || left.integrity !== right.integrity || left.environmentId !== right.environmentId) return false
  if (leftKind === 'python' && right.kind === 'python') {
    if (!isPythonRuntime(left)) return false
    return left.stdlibIntegrity === right.stdlibIntegrity && left.treeSha === right.treeSha && left.executableRelative === right.executableRelative && left.archiveSha === right.archiveSha
  }
  return true
}

export function runtimePin(runtime: RuntimeMetadata | PythonRuntimeMetadata): PackageRuntimePin {
  if (runtime.kind === 'python') {
    if (!isPythonRuntime(runtime)) throw new AgentPackageError('RUNTIME_NOT_READY', 'Python runtime metadata is incomplete', 422)
    return runtime
  }
  return { kind: 'node', version: runtime.version, integrity: runtime.integrity, environmentId: runtime.environmentId }
}

function isPythonRuntime(runtime: RuntimeMetadata | PythonRuntimeMetadata): runtime is VerifiedPythonRuntime {
  return runtime.kind === 'python' && typeof (runtime as Partial<PythonRuntimeMetadata>).stdlibIntegrity === 'string' && typeof (runtime as Partial<PythonRuntimeMetadata>).treeSha === 'string' && typeof (runtime as Partial<PythonRuntimeMetadata>).executableRelative === 'string' && typeof (runtime as Partial<PythonRuntimeMetadata>).archiveSha === 'string'
}

export function launchFor(checked: Awaited<ReturnType<typeof checkPackage>>, runtime: RuntimeMetadata | PythonRuntimeMetadata, runtimeDir?: string): { kind: 'node' | 'python'; executable: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv } {
  const kind = runtime.kind ?? 'node'
  if (kind === 'node') return { kind: 'node', executable: process.execPath, args: [checked.entrypoint] }
  if (runtime.kind !== 'python' || !runtimeDir || !isPythonRuntime(runtime)) throw new AgentPackageError('RUNTIME_NOT_READY', 'Portable Python runtime directory is not configured', 422)
  const launch = pythonLaunch(runtime, runtimeDir, checked.entrypointModule ?? checked.entrypoint, checked.entrypointKind === 'module', checked.root)
  return { kind: 'python', ...launch }
}

export function checkedCapabilities(manifest: { runtime: { kind: string }; lifecycle: { pause: string; resume: true; cancel: true }; permissions: string[] }): string[] {
  const result: string[] = []
  if (manifest.lifecycle.resume) result.push('resume')
  if (manifest.lifecycle.cancel) result.push('cancel')
  if (manifest.lifecycle.pause === 'checkpoint') result.push('pause.checkpoint')
  if (manifest.permissions.includes('review.request')) result.push('structuredReviews')
  if (manifest.permissions.some((permission) => permission === 'artifact.publish' || permission.startsWith('canvas.'))) result.push('toolBroker')
  return result
}

export type PackageLaunch = Awaited<ReturnType<typeof launchFor>>
