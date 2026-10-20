import crypto from 'node:crypto'
import path from 'node:path'
import type {
  AgentConnection,
  AgentEnvelope,
  AgentGrant,
  AgentMessageType,
  AgentStartPayload,
} from '../../../packages/agent-protocol/index.js'
import { AGENT_MAX_MESSAGE_BYTES } from '../../../packages/agent-protocol/index.js'
import { logNote } from '../log.js'
import type { AgentTaskRecord } from './types.js'
import type { AgentProtocolValidator } from './validation.js'
import type { ManagedProcess } from './host-process.js'

export interface SafeEnvironmentOptions {
  packageDir?: string
  stateDir?: string
}

export function safeEnvironment(
  taskId: string,
  executionId: string,
  workspace: string,
  options?: SafeEnvironmentOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    CANAI_AGENT_PROTOCOL_VERSION: '1.0',
    CANAI_AGENT_TASK_ID: taskId,
    CANAI_AGENT_EXECUTION_ID: executionId,
    CANAI_AGENT_PACKAGE_DIR: options?.packageDir ?? workspace,
    CANAI_AGENT_WORK_DIR: workspace,
    CANAI_AGENT_STATE_DIR: options?.stateDir ?? path.join(workspace, 'state'),
    CANAI_AGENT_WORKSPACE: workspace,
  }
  const pathValue = process.env.PATH ?? process.env.Path
  if (pathValue) env.PATH = pathValue
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]
  return env
}

export function writeAgentEnvelope(validator: AgentProtocolValidator, managed: ManagedProcess, message: AgentEnvelope): void {
  try { validator.assertEnvelope(message, 'host-to-agent') } catch (error) {
    logNote('agent-protocol', error instanceof Error ? error.message : String(error))
    return
  }
  if (!managed.closing && !managed.child.stdin.destroyed) {
    try { managed.child.stdin.write(JSON.stringify(message) + '\n') } catch (error) {
      if (!managed.closing && !/EPIPE/u.test(error instanceof Error ? error.message : String(error))) {
        logNote('agent-stdin', error instanceof Error ? error.message : String(error))
      }
    }
  }
}

export function writeHostAck(
  validator: AgentProtocolValidator,
  managed: ManagedProcess,
  acceptedMessageId: string,
  eventCursor: number,
): void {
  writeAgentEnvelope(validator, managed, {
    protocolVersion: '1.0',
    messageId: 'host-ack-' + crypto.randomUUID(),
    taskId: managed.taskId,
    executionId: managed.executionId,
    type: 'ack',
    replyTo: acceptedMessageId,
    payload: { eventCursor, acceptedMessageId, session: { maxMessageBytes: AGENT_MAX_MESSAGE_BYTES, heartbeatIntervalMs: 5_000 } },
  })
}

export function wireReceipt(receipt: AgentTaskRecord['receipts'][number]): Record<string, unknown> {
  return {
    operationId: receipt.operationId,
    tool: receipt.tool,
    receiptId: receipt.receiptId,
    status: receipt.status,
    ...(receipt.result ? { result: receipt.result } : {}),
    ...(receipt.error ? { error: receipt.error } : {}),
  }
}

export function writeToolResult(
  validator: AgentProtocolValidator,
  managed: ManagedProcess,
  request: AgentEnvelope,
  receipt: AgentTaskRecord['receipts'][number],
): void {
  writeAgentEnvelope(validator, managed, {
    protocolVersion: '1.0',
    messageId: 'host-result-' + crypto.randomUUID(),
    taskId: request.taskId,
    executionId: managed.executionId,
    type: 'tool.result',
    replyTo: request.messageId,
    payload: wireReceipt(receipt),
  })
}

export function makeHostEnvelope(task: AgentTaskRecord, type: AgentMessageType, payload: Record<string, unknown>): AgentEnvelope {
  return {
    protocolVersion: '1.0',
    messageId: 'host-' + crypto.randomUUID(),
    taskId: task.taskId,
    executionId: task.currentExecutionId ?? '',
    type,
    payload,
  }
}

export function startPayload(task: AgentTaskRecord, access: { connections: AgentConnection[]; grants: AgentGrant[] } = { connections: [], grants: [] }): AgentStartPayload {
  const generationPins = task.generationBudget?.pins?.length
    ? task.generationBudget.pins.map((pin) => ({
        kind: pin.kind,
        modelId: pin.modelId,
        catalogRevision: task.generationBudget!.catalogRevision,
        params: structuredClone(pin.params ?? {}),
      }))
    : undefined
  return {
    taskType: task.taskType,
    instruction: structuredClone(task.instruction),
    input: structuredClone(task.input),
    projectRef: structuredClone(task.projectRef),
    inputs: structuredClone(task.inputs),
    workspaceId: task.workspaceId,
    connections: structuredClone(access.connections),
    grants: structuredClone(access.grants),
    ...(task.spendBudget ? { spendBudget: structuredClone(task.spendBudget) } : {}),
    ...(generationPins ? { generationPins } : {}),
  }
}

export function brokerTask(workspaceRoot: string, task: AgentTaskRecord): AgentTaskRecord {
  return { ...task, workspacePath: path.resolve(workspaceRoot, task.workspacePath) }
}
