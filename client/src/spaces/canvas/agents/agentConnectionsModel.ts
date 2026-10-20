import type {
  AgentPackageCheckView,
  AgentPackageInstallationView,
  AgentPackageManageRequest,
  AgentPackageInstallRequest,
  AgentPackageUpdateRequest,
} from '../../../../../packages/agent-protocol/index'
import type { NoticeTone } from '../../../ui/InlineNotice'
import type { AgentPackageSummary } from '../../../../../packages/agent-protocol/index'

export type SourceKind = 'git' | 'archive'

export type SourceDraft = {
  kind: SourceKind
  url: string
  ref: string
  subdir: string
  archiveId?: string
  archiveSha?: string
  archiveSize?: number
  archiveName?: string
}

export type PendingMutation =
  | { kind: 'install'; input: AgentPackageInstallRequest }
  | { kind: 'update'; input: AgentPackageUpdateRequest }
  | { kind: 'manage'; action: 'enable' | 'disable' | 'rollback' | 'remove'; input: AgentPackageManageRequest }

export type ConnectionNotice = { tone: NoticeTone; title: string; detail: string }

export type ConnectionSession = {
  check: AgentPackageCheckView | null
  trustConfirmed: boolean
  notice: ConnectionNotice | null
  pending: PendingMutation | null
  reinstallInstallationId: string | null
}

export type UploadPending = { requestId: string; archive: Blob; name: string }

export const sourceDrafts = new Map<string, SourceDraft>()
export const connectionSessions = new Map<string, ConnectionSession>()

export function idFor(projectRef: { source: string; id: string }): string {
  return `${projectRef.source}:${projectRef.id}`
}

export function newRequestId(prefix: string): string {
  return `ui-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function sourceView(check: AgentPackageCheckView): string {
  if (check.source.kind === 'archive') return [`ZIP ${check.source.archiveId ?? 'upload'}`, check.source.archiveSha, check.source.subdir].filter(Boolean).join(' · ')
  return [check.source.canonicalUrl ?? 'GitHub', check.source.requestedRef, check.source.subdir].filter(Boolean).join(' · ')
}

export function installationSourceView(installation: AgentPackageInstallationView): string {
  if (installation.source.kind === 'archive') return [`ZIP ${installation.source.archiveId ?? 'upload'}`, installation.source.archiveSha, installation.source.subdir].filter(Boolean).join(' · ')
  return [installation.source.canonicalUrl ?? 'Saved source', installation.source.requestedRef, installation.source.subdir].filter(Boolean).join(' · ')
}

export function samePackageSourceFamily(
  left: AgentPackageSummary['source'] | undefined,
  right: AgentPackageCheckView['source'] | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === 'archive' && right.kind === 'archive') return true
  if (left.kind !== 'git' || right.kind !== 'git') return false
  return left.canonicalUrl === right.canonicalUrl
    && (left.requestedRef ?? '') === (right.requestedRef ?? '')
    && (left.subdir ?? '') === (right.subdir ?? '')
}

export function issueTone(severity: 'error' | 'warning'): NoticeTone {
  return severity === 'error' ? 'error' : 'warning'
}
