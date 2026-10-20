import type { AgentPackageController } from './agentPanelController'
import { AgentConnectionsLibrary } from './AgentConnectionsLibrary'
import { AgentConnectionsSource } from './AgentConnectionsSource'
import { AgentPythonRuntimeSection } from './AgentPythonRuntimeSection'
import { useAgentConnectionsSource } from './useAgentConnectionsSource'
import { useAgentPythonRuntime } from './useAgentPythonRuntime'

export function AgentConnectionsPanel({
  controller,
  projectRef,
}: {
  controller: AgentPackageController
  projectRef: { source: 'local' | 'cloud'; id: string }
}) {
  const runtimeState = useAgentPythonRuntime(controller, projectRef)
  const source = useAgentConnectionsSource(controller, projectRef, Boolean(runtimeState.runtime?.ready))
  return (
    <div className="agent-connections">
      <AgentPythonRuntimeSection runtimeState={runtimeState} />
      <AgentConnectionsSource projectRef={projectRef} source={source} />
      <AgentConnectionsLibrary controller={controller} source={source} />
    </div>
  )
}
