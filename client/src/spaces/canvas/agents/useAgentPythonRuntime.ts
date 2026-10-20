import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentPythonRuntimeStatus } from './agentHostClient'
import type { AgentPackageController } from './agentPanelController'
import { idFor } from './agentConnectionsModel'

export interface AgentPythonRuntimeController {
  runtime: AgentPythonRuntimeStatus | null
  runtimeConsent: boolean
  runtimeBusy: boolean
  runtimeOperation: 'status' | 'install' | null
  runtimeError: string | null
  setRuntimeConsent(value: boolean): void
  retryRuntimeStatus(): void
  installRuntime(): void
}

export function useAgentPythonRuntime(
  controller: Pick<AgentPackageController, 'getPythonRuntime' | 'installPythonRuntime'>,
  projectRef: { source: 'local' | 'cloud'; id: string },
): AgentPythonRuntimeController {
  const projectKey = idFor(projectRef)
  const [runtime, setRuntime] = useState<AgentPythonRuntimeStatus | null>(null)
  const [runtimeConsent, setRuntimeConsent] = useState(false)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [runtimeOperation, setRuntimeOperation] = useState<'status' | 'install' | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const sourceSerial = useRef(0)
  const statusSerial = useRef(0)
  const installSerial = useRef(0)
  const operationRef = useRef<'status' | 'install' | null>(null)
  const currentProjectKey = useRef(projectKey)
  currentProjectKey.current = projectKey

  const beginOperation = (operation: 'status' | 'install') => {
    operationRef.current = operation
    setRuntimeBusy(true)
    setRuntimeOperation(operation)
  }
  const finishOperation = (operation: 'status' | 'install') => {
    if (operationRef.current !== operation) return
    operationRef.current = null
    setRuntimeBusy(false)
    setRuntimeOperation(null)
  }

  useEffect(() => {
    const requestSourceSerial = ++sourceSerial.current
    let active = true
    setRuntime(null)
    setRuntimeConsent(false)
    operationRef.current = null
    setRuntimeBusy(false)
    setRuntimeOperation(null)
    setRuntimeError(null)
    const requestStatusSerial = ++statusSerial.current
    beginOperation('status')
    void controller.getPythonRuntime().then((value) => {
      if (active && requestSourceSerial === sourceSerial.current && requestStatusSerial === statusSerial.current && currentProjectKey.current === projectKey) setRuntime(value)
    }).catch((error) => {
      if (active && requestSourceSerial === sourceSerial.current && requestStatusSerial === statusSerial.current && currentProjectKey.current === projectKey) setRuntimeError(error instanceof Error ? error.message : 'Python runtime status unavailable')
    }).finally(() => {
      if (active && requestSourceSerial === sourceSerial.current && requestStatusSerial === statusSerial.current && currentProjectKey.current === projectKey) finishOperation('status')
    })
    return () => {
      active = false
      sourceSerial.current += 1
      statusSerial.current += 1
      operationRef.current = null
    }
  }, [controller.getPythonRuntime, projectKey, projectRef.source, projectRef.id])

  const retryRuntimeStatus = useCallback(() => {
    if (operationRef.current === 'install') return
    const requestSourceSerial = sourceSerial.current
    const requestStatusSerial = ++statusSerial.current
    setRuntimeError(null)
    beginOperation('status')
    void controller.getPythonRuntime().then((value) => {
      if (requestSourceSerial === sourceSerial.current && requestStatusSerial === statusSerial.current && currentProjectKey.current === projectKey) setRuntime(value)
    }).catch((error) => {
      if (requestSourceSerial === sourceSerial.current && requestStatusSerial === statusSerial.current && currentProjectKey.current === projectKey) setRuntimeError(error instanceof Error ? error.message : 'Status unavailable')
    }).finally(() => {
      if (requestSourceSerial === sourceSerial.current && requestStatusSerial === statusSerial.current && currentProjectKey.current === projectKey) finishOperation('status')
    })
  }, [controller.getPythonRuntime, projectKey])

  const installRuntime = async () => {
    if (!runtimeConsent || operationRef.current) return
    const requestSourceSerial = sourceSerial.current
    const requestInstallSerial = ++installSerial.current
    statusSerial.current += 1
    beginOperation('install')
    setRuntimeError(null)
    try {
      const value = await controller.installPythonRuntime()
      if (requestSourceSerial === sourceSerial.current && requestInstallSerial === installSerial.current && currentProjectKey.current === projectKey) {
        setRuntime(value)
        setRuntimeConsent(false)
        if (!value.ready) setRuntimeError(value.reason ?? 'Portable Python failed the check')
      }
    } catch (error) {
      if (requestSourceSerial === sourceSerial.current && requestInstallSerial === installSerial.current && currentProjectKey.current === projectKey) setRuntimeError(error instanceof Error ? error.message : 'Could not prepare portable Python')
    } finally {
      if (requestSourceSerial === sourceSerial.current && requestInstallSerial === installSerial.current && currentProjectKey.current === projectKey) finishOperation('install')
    }
  }

  return { runtime, runtimeConsent, runtimeBusy, runtimeOperation, runtimeError, setRuntimeConsent, retryRuntimeStatus, installRuntime: () => { void installRuntime() } }
}
