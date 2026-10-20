import type {
  AgentInputSchemaView,
  AgentPackageCheckView,
  AgentPackageInstallationView,
  AgentPackageInstallRequest,
  AgentPackageLibraryView,
  AgentPackageSummary,
  AgentTaskView,
} from '../../../../../packages/agent-protocol/index'

export type AgentTaskInputValues = Record<string, unknown>
export type AgentTaskInputErrors = Record<string, string>

/** Stable source pin used to scope late check responses to the current form. */
export function sourceCheckKey(source: {
  kind: 'git' | 'archive'
  url?: string
  ref?: string
  subdir?: string
  archiveId?: string
}): string {
  return JSON.stringify({
    kind: source.kind,
    url: source.url?.trim() ?? '',
    ref: source.ref?.trim() ?? '',
    subdir: source.subdir?.trim() ?? '',
    archiveId: source.archiveId ?? '',
  })
}

/** Failed persisted records are history/recovery entries, never launchable packages. */
export function failedPackageInstallations(
  installations: AgentPackageLibraryView['installations'] | undefined,
): AgentPackageInstallationView[] {
  return (installations ?? [])
    .filter((installation) => installation.status === 'failed')
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function sourcePart(value: string | undefined): string {
  return value ?? ''
}

export function packageSourceMatchesInstallation(
  check: Pick<AgentPackageCheckView, 'manifest' | 'source'>,
  installation: Pick<AgentPackageInstallationView, 'packageId' | 'source'>,
): boolean {
  if (check.manifest.id !== installation.packageId || check.source.kind !== installation.source.kind) return false
  if (check.source.kind === 'archive' && installation.source.kind === 'archive') {
    return check.source.archiveId === installation.source.archiveId
      && sourcePart(check.source.subdir) === sourcePart(installation.source.subdir)
  }
  if (check.source.kind !== 'git' || installation.source.kind !== 'git') return false
  const checkUrl = check.source.canonicalUrl
  const installationUrl = installation.source.canonicalUrl
  return Boolean(checkUrl && installationUrl)
    && checkUrl === installationUrl
    && sourcePart(check.source.requestedRef) === sourcePart(installation.source.requestedRef)
    && sourcePart(check.source.subdir) === sourcePart(installation.source.subdir)
}

/** Build a fresh-trust reinstall request for one persisted failed installation. */
export function reinstallPackageRequest(
  check: AgentPackageCheckView,
  installation: AgentPackageInstallationView,
  requestId: string,
): AgentPackageInstallRequest | null {
  if (!check.supported || !packageSourceMatchesInstallation(check, installation)) return null
  return {
    requestId,
    checkId: check.checkId,
    expectedRevision: check.revision,
    trustConfirmed: true,
    approvedPermissions: [...new Set(check.trust.requiredPermissions)],
    priorInstallationId: installation.installationId,
  }
}

/**
 * The panel intentionally renders only this small, data-only schema.  A
 * package never gets to provide JSX or an arbitrary form description.
 */
export function inputDefaults(schema: AgentInputSchemaView | undefined): AgentTaskInputValues {
  if (!schema) return {}
  return Object.fromEntries(schema.fields.flatMap((field) => {
    if (field.default !== undefined) return [[field.key, field.default]]
    if (field.kind === 'boolean') return [[field.key, false]]
    return []
  }))
}

function numberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function validateTaskInput(
  schema: AgentInputSchemaView | undefined,
  values: AgentTaskInputValues,
): AgentTaskInputErrors {
  const errors: AgentTaskInputErrors = {}
  if (!schema) return errors
  for (const field of schema.fields) {
    const value = values[field.key]
    const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    if (field.required && empty) {
      errors[field.key] = 'Field is required'
      continue
    }
    if (empty) continue
    if (field.kind === 'string' && typeof value !== 'string') {
      errors[field.key] = 'Text is required'
    } else if (field.kind === 'number' && !numberValue(value)) {
      errors[field.key] = 'Number is required'
    } else if (field.kind === 'boolean' && typeof value !== 'boolean') {
      errors[field.key] = 'Toggle is required'
    } else if (field.kind === 'enum' && (typeof value !== 'string' || !field.enum?.includes(value))) {
      errors[field.key] = 'Choose a value from the list'
    } else if (field.kind === 'number' && numberValue(value)) {
      if ((field as typeof field & { integer?: boolean }).integer && !Number.isInteger(value)) errors[field.key] = 'An integer is required'
      if (field.minimum !== undefined && value < field.minimum) errors[field.key] = `Minimum: ${field.minimum}`
      if (field.maximum !== undefined && value > field.maximum) errors[field.key] = `Maximum: ${field.maximum}`
    } else if (field.kind === 'string' && typeof value === 'string') {
      if (field.minLength !== undefined && value.length < field.minLength) errors[field.key] = `Minimum characters: ${field.minLength}`
      if (field.maxLength !== undefined && value.length > field.maxLength) errors[field.key] = `Maximum characters: ${field.maxLength}`
    }
  }
  return errors
}

/** Strip only missing optional values; values are otherwise sent unchanged. */
export function taskInputPayload(values: AgentTaskInputValues): AgentTaskInputValues {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

export function mergeTaskInputValue(
  schema: AgentInputSchemaView | undefined,
  current: AgentTaskInputValues,
  key: string,
  value: unknown,
): AgentTaskInputValues {
  return { ...inputDefaults(schema), ...current, [key]: value }
}

export function launchablePackages(packages: readonly AgentPackageSummary[]): AgentPackageSummary[] {
  return packages.filter((pkg) => (
    pkg.handshake === 'ready'
    && (pkg.status === undefined || pkg.status === 'ready')
    && pkg.active !== false
    && pkg.taskTypes.length > 0
  ))
}

export function packageStatusLabel(pkg: Pick<AgentPackageSummary, 'status' | 'handshake' | 'active'>): string {
  if (pkg.handshake === 'failed' || pkg.status === 'failed') return 'Not ready'
  if (pkg.status === 'unsupported') return 'Unsupported'
  if (pkg.status === 'disabled' || pkg.active === false) return 'Disabled'
  return 'Ready'
}

export function packageCanBeRemoved(
  pkg: Pick<AgentPackageSummary, 'id' | 'installationId'>,
  tasks: readonly Pick<AgentTaskView, 'packageId' | 'installationId' | 'state'>[],
): boolean {
  return !tasks.some((task) => {
    const sameInstallation = pkg.installationId && task.installationId
      ? pkg.installationId === task.installationId
      : true
    return sameInstallation && task.packageId === pkg.id && !['succeeded', 'failed', 'cancelled', 'uncertain'].includes(task.state)
  })
}

export function checkCanBeTrusted(check: AgentPackageCheckView, approvedPermissions: readonly string[]): boolean {
  if (!check.supported || check.trust.explicitTrustRequired !== true) return false
  if (check.issues.some((issue) => issue.severity === 'error')) return false
  const required = [...new Set(check.trust.requiredPermissions)].sort()
  const approved = [...new Set(approvedPermissions)].sort()
  return required.length === approved.length && required.every((permission, index) => permission === approved[index])
}
