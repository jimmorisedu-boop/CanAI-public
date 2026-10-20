import { useEffect, useMemo, useState } from 'react'
import type { ProjectRef } from '../../../../../packages/agent-protocol/index'
import type { CanvasStore } from '../konva/canvasStore'
import { InlineNotice } from '../../../ui/InlineNotice'
import type { AgentPanelController } from './agentPanelController'
import type { AgentPresentationCapability } from './agentCapabilities'
import { AgentLaunchSection } from './AgentLaunchSection'
import {
  inputDefaults,
  launchablePackages,
  mergeTaskInputValue,
  validateTaskInput,
  type AgentTaskInputValues,
} from './agentPackageModel'

const packageByProject = new Map<string, string>()
const taskByProject = new Map<string, string>()
const inputByProject = new Map<string, Record<string, AgentTaskInputValues>>()

function projectKey(ref: ProjectRef): string {
  return `${ref.source}:${ref.id}`
}

/**
 * The lower action dock owns the launch form. AgentPanel only observes tasks;
 * both receive the same board controller from CanvasSpace.
 */
export function AgentLaunchComposer({
  controller,
  projectRef,
  store,
  enabled = true,
  compact = true,
  capability,
  flushBoardBeforeCapture,
}: {
  controller: AgentPanelController
  projectRef: ProjectRef
  store: CanvasStore
  enabled?: boolean
  compact?: boolean
  /** Transport-owned launch policy; a Cloud board never falls back to Host. */
  capability?: AgentPresentationCapability
  /** Persist optimistic local board state before native media capture. */
  flushBoardBeforeCapture?: () => Promise<{ revision: number }>
}) {
  const key = projectKey(projectRef)
  const [packageId, setPackageId] = useState(() => packageByProject.get(key) ?? '')
  const [taskType, setTaskType] = useState(() => taskByProject.get(key) ?? '')
  const [inputValues, setInputValues] = useState<Record<string, AgentTaskInputValues>>(() => inputByProject.get(key) ?? {})

  useEffect(() => {
    setPackageId(packageByProject.get(key) ?? '')
    setTaskType(taskByProject.get(key) ?? '')
    setInputValues(inputByProject.get(key) ?? {})
  }, [key])

  const packages = controller.state.packages
  const readyPackages = useMemo(() => launchablePackages(packages), [packages])
  const selectedPackage = readyPackages.find((pkg) => pkg.id === packageId) ?? readyPackages[0]
  const selectedType = selectedPackage?.taskTypes.find((type) => type.id === taskType) ?? selectedPackage?.taskTypes[0]
  const formKey = `${selectedPackage?.id ?? ''}:${selectedType?.id ?? ''}`
  const taskInput = inputValues[formKey] ?? inputDefaults(selectedType?.inputSchema)
  const inputErrors = validateTaskInput(selectedType?.inputSchema, taskInput)

  const choosePackage = (value: string) => {
    packageByProject.set(key, value)
    taskByProject.set(key, '')
    setPackageId(value)
    setTaskType('')
  }
  const chooseType = (value: string) => {
    taskByProject.set(key, value)
    setTaskType(value)
  }
  const changeInput = (field: string, value: unknown) => {
    setInputValues((current) => {
      const next = {
        ...current,
        [formKey]: mergeTaskInputValue(selectedType?.inputSchema, current[formKey] ?? {}, field, value),
      }
      inputByProject.set(key, next)
      return next
    })
  }

  if (!enabled) return null
  const canLaunch = capability?.canLaunch === true
  if (!canLaunch) {
    return (
      <div className="agent-launch-composer agent-launch-composer--unavailable" aria-label="Agent runs">
        <InlineNotice
          tone="info"
          title="Running is unavailable in this mode"
          detail={capability?.reason ?? 'The transport did not grant permission to run a shared task.'}
        />
      </div>
    )
  }

  return (
    <div className="agent-launch-composer" aria-label="New agent task">
      <AgentLaunchSection
        controller={controller}
        packages={packages}
        readyPackages={readyPackages}
        selectedPackage={selectedPackage}
        selectedType={selectedType}
        projectRef={projectRef}
        llmCatalog={controller.llmCatalog}
        generationCatalog={controller.generationCatalog}
        taskInput={taskInput}
        inputErrors={inputErrors}
        canLaunch
        compact={compact}
        store={store}
        capability={capability}
        flushBoardBeforeCapture={flushBoardBeforeCapture}
        onPackageChange={choosePackage}
        onTaskTypeChange={chooseType}
        onInputChange={changeInput}
      />
    </div>
  )
}
