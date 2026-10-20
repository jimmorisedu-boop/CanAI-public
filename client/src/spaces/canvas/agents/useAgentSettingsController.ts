import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentPackageCheckRequest,
  AgentPackageInstallRequest,
  AgentPackageLibraryView,
  AgentPackageManageRequest,
  AgentPackageUpdateRequest,
} from '../../../../../packages/agent-protocol/index'
import { makeAgentPanelState, type AgentPanelState } from './agentPanelModel'
import { classifyAgentHostFailure, createAgentHostClient, type AgentHostClient } from './agentHostClient'
import type { AgentPackageController } from './agentPanelController'

/**
 * Package settings deliberately have their own, task-free controller. The
 * settings modal is not a board and must not open a board task list or an SSE
 * stream merely because somebody wants to inspect/install a package.
 */
export function useAgentSettingsController(
  client?: AgentHostClient,
): AgentPackageController & { refresh(): Promise<void> } {
  const hostClient = useMemo(() => client ?? createAgentHostClient(), [client])
  const settingsRef = useMemo(() => ({ source: 'local' as const, id: '__settings__' }), [])
  const [state, setState] = useState<AgentPanelState>(() => makeAgentPanelState(settingsRef))
  const [packageRevision, setPackageRevision] = useState(0)
  const epoch = useRef(0)

  const refresh = useCallback(async () => {
    const currentEpoch = epoch.current
    setState((current) => ({ ...current, connection: 'connecting', error: null }))
    try {
      const library = await hostClient.listPackageLibrary()
      if (currentEpoch !== epoch.current) return
      setPackageRevision(library.revision)
      setState((current) => ({
        ...current,
        packages: library.packages,
        installations: library.installations ?? [],
        connection: 'live',
        error: null,
      }))
    } catch (error) {
      if (currentEpoch !== epoch.current) return
      const failure = classifyAgentHostFailure(error)
      setState((current) => ({
        ...current,
        connection: failure.domainRefusal ? 'live' : 'offline',
        error: failure.message,
      }))
    }
  }, [hostClient])

  useEffect(() => {
    epoch.current += 1
    const currentEpoch = epoch.current
    void refresh()
    return () => {
      // Incrementing before an awaited request settles prevents a closed
      // settings modal from mutating the next modal's package snapshot.
      if (epoch.current === currentEpoch) epoch.current += 1
    }
  }, [refresh])

  const applyLibrary = useCallback((library: AgentPackageLibraryView) => {
    setPackageRevision(library.revision)
    setState((current) => ({
      ...current,
      packages: library.packages,
      installations: library.installations ?? [],
      connection: 'live',
      error: null,
    }))
  }, [])

  const updateLibrary = useCallback(async (action: () => Promise<AgentPackageLibraryView>) => {
    const currentEpoch = epoch.current
    const library = await action()
    if (currentEpoch === epoch.current) applyLibrary(library)
  }, [applyLibrary])

  const uploadPackageArchive = useCallback((input: { requestId: string; archive: Blob; provenance?: Record<string, string> }) => (
    hostClient.uploadPackageArchive(input)
  ), [hostClient])
  const getPythonRuntime = useCallback(() => (
    hostClient.getPythonRuntime
      ? hostClient.getPythonRuntime()
      : Promise.resolve({ supported: false, ready: false, version: '3.13.16', rootRelative: '', reason: 'Host does not support portable Python' })
  ), [hostClient])
  const installPythonRuntime = useCallback(() => {
    if (!hostClient.installPythonRuntime) return Promise.reject(new Error('Host does not support portable Python setup'))
    return hostClient.installPythonRuntime()
  }, [hostClient])
  const checkPackage = useCallback((input: AgentPackageCheckRequest) => hostClient.checkPackage(input), [hostClient])
  const installPackage = useCallback((input: AgentPackageInstallRequest) => updateLibrary(() => hostClient.installPackage(input)), [hostClient, updateLibrary])
  const updatePackage = useCallback((input: AgentPackageUpdateRequest) => updateLibrary(() => hostClient.updatePackage(input)), [hostClient, updateLibrary])
  const managePackage = useCallback((action: 'enable' | 'disable' | 'rollback' | 'remove', input: AgentPackageManageRequest) => updateLibrary(() => hostClient.managePackage(action, input)), [hostClient, updateLibrary])

  return {
    state,
    packageRevision,
    uploadPackageArchive,
    getPythonRuntime,
    installPythonRuntime,
    checkPackage,
    installPackage,
    updatePackage,
    managePackage,
    refresh,
  }
}
