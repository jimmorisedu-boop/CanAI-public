import type { AgentPackageInstallationView, AgentPackageManageRequest } from '../../../packages/agent-protocol/index.js'
import { AgentPackageError } from './package-errors.js'
import { AgentPackageLibrary, type LibraryInstallation } from './library.js'
import type { AgentPackageRegistry } from './packages.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/u

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new AgentPackageError('REQUEST_INVALID', `${label} is invalid`)
  return value
}

export interface PackageManagerManageOptions {
  library: AgentPackageLibrary
  registry: AgentPackageRegistry
  activeTaskPins?: () => Promise<Set<string>> | Set<string>
  packageLifecycleLock?: <T>(operation: () => Promise<T>) => Promise<T>
  revalidate: (target: LibraryInstallation) => Promise<void>
}

export async function managePackage(
  action: 'enable' | 'disable' | 'rollback' | 'remove',
  input: AgentPackageManageRequest,
  options: PackageManagerManageOptions,
): Promise<AgentPackageInstallationView & { revision: number }> {
  const operation = () => options.library.serialized(async () => {
    const requestId = id(input.requestId, 'requestId')
    const fingerprint = AgentPackageLibrary.fingerprint({ action, input })
    const document = options.library.snapshot()
    const prior = document.requests[requestId]
    if (prior) {
      if (prior.action !== action || prior.fingerprint !== fingerprint) throw new AgentPackageError('REQUEST_REUSE', 'requestId was already used for another command', 409)
      return prior.response as AgentPackageInstallationView & { revision: number }
    }
    if (input.expectedRevision !== document.revision) throw new AgentPackageError('LIBRARY_REVISION_STALE', 'Library revision is stale', 409)
    const targetId = id(input.installationId ?? '', 'installationId')
    const target = document.installations[targetId]
    if (!target || target.status === 'removed') throw new AgentPackageError('INSTALLATION_NOT_FOUND', 'Package installation was not found', 404)
    if (action === 'remove' || action === 'disable') {
      const pins = await options.activeTaskPins?.() ?? new Set<string>()
      if (pins.has(targetId)) throw new AgentPackageError('PACKAGE_IN_USE', 'Installation is pinned by an active task', 409)
      if (action === 'remove' && document.active[target.packageId] === targetId) throw new AgentPackageError('PACKAGE_ACTIVE', 'Disable the active installation first', 409)
    }
    if ((action === 'enable' || action === 'rollback') && (target.status === 'failed' || target.status === 'unsupported')) {
      throw new AgentPackageError('INSTALLATION_UNAVAILABLE', 'A corrupt or unsupported installation cannot be activated', 409)
    }
    if (action === 'disable' && (target.status === 'failed' || target.status === 'unsupported' || !options.registry.getInstallation(targetId))) {
      throw new AgentPackageError('INSTALLATION_UNAVAILABLE', 'A corrupt installation cannot be disabled without a Host recheck', 409)
    }
    if (action === 'rollback' && target.status === 'disabled') throw new AgentPackageError('INSTALLATION_DISABLED', 'A disabled installation cannot be made the rollback target', 409)
    if (action === 'enable' || action === 'rollback') {
      await options.revalidate(target)
      const registered = options.registry.getInstallation(targetId)
      if (!registered || registered.manifest.id !== target.packageId || registered.packageSha !== target.packageSha || registered.handshake !== 'ready') {
        throw new AgentPackageError('INSTALLATION_UNAVAILABLE', 'Installation failed the Host recheck', 409)
      }
    }
    const nextStatus: LibraryInstallation['status'] = action === 'disable' ? 'disabled' : action === 'remove' ? 'removed' : 'ready'
    const committed = await options.library.transactionUnlocked(document.revision, (draft, revision) => {
      if (action === 'enable' || action === 'rollback') {
        for (const existingRecord of Object.values(draft.installations)) {
          if (existingRecord.packageId === target.packageId) existingRecord.active = false
        }
      }
      const saved = { ...target, status: nextStatus, active: action === 'remove' ? false : action !== 'disable', updatedAt: Date.now() }
      draft.installations[targetId] = saved
      if (action === 'disable' || action === 'remove') { if (draft.active[target.packageId] === targetId) delete draft.active[target.packageId] }
      else draft.active[target.packageId] = targetId
      const response = { ...saved, revision }
      draft.requests[requestId] = { action, fingerprint, response, createdAt: Date.now() }
      return response
    })
    if (action === 'remove') options.registry.removeInstallation(targetId)
    else if (action === 'disable' && options.registry.getInstallation(targetId)) options.registry.setDisabled(target.packageId, targetId)
    else options.registry.setActive(target.packageId, targetId)
    return committed.value
  })
  return options.packageLifecycleLock ? options.packageLifecycleLock(operation) : operation()
}
