import fs from 'node:fs'
import path from 'node:path'
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { serverRootDir } from '../config.js'
import type { AgentEnvelope, AgentMessageType } from '../../../packages/agent-protocol/index.js'

const DEFAULT_SCHEMA_DIR = path.resolve(serverRootDir, '..', 'docs', 'agents')
const AGENT_TO_HOST_TYPES = new Set<AgentMessageType>([
  'hello', 'task.progress', 'task.checkpoint', 'tool.request', 'review.request',
  'task.paused', 'task.finished', 'heartbeat',
])
const HOST_TO_AGENT_TYPES = new Set<AgentMessageType>([
  'ack', 'task.start', 'task.resume', 'tool.result', 'review.decision',
  'task.pause', 'task.cancel', 'protocol.error',
])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]*$/u
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u

export interface ValidationIssue {
  keyword?: string
  instancePath?: string
  message?: string
}

export class AgentProtocolError extends Error {
  readonly code: string
  readonly issues: ValidationIssue[]

  constructor(code: string, message: string, issues: ValidationIssue[] = []) {
    super(message)
    this.name = 'AgentProtocolError'
    this.code = code
    this.issues = issues
  }
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
}

function issuesOf(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    message: error.message,
  }))
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProtocolError('PROTOCOL_INVALID', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function checkId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value.length > 160) {
    throw new AgentProtocolError('PROTOCOL_INVALID', `${label}: invalid ID`)
  }
  return value
}

export function checkRelativePath(value: unknown, label = 'path'): string {
  if (typeof value !== 'string' || value.length > 240 || !SAFE_PATH.test(value)) {
    throw new AgentProtocolError('PATH_INVALID', `${label}: a relative path inside the workspace is required`)
  }
  return value
}

export interface ManifestValidationResult {
  manifest: Record<string, unknown>
  errors: ValidationIssue[]
}

export class AgentProtocolValidator {
  readonly schemaDir: string
  private readonly protocol: ValidateFunction
  private readonly manifest: ValidateFunction

  constructor(schemaDir = DEFAULT_SCHEMA_DIR) {
    this.schemaDir = schemaDir
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
    addFormats(ajv)
    const protocolSchema = readJson(path.join(schemaDir, 'protocol.schema.json')) as object
    const manifestSchema = readJson(path.join(schemaDir, 'canai.agent.schema.json')) as object
    this.protocol = ajv.compile(protocolSchema)
    this.manifest = ajv.compile(manifestSchema)
  }

  validateManifest(value: unknown): ManifestValidationResult {
    const valid = this.manifest(value)
    return { manifest: assertRecord(value, 'Manifest'), errors: valid ? [] : issuesOf(this.manifest.errors) }
  }

  assertManifest(value: unknown): Record<string, unknown> {
    const result = this.validateManifest(value)
    if (result.errors.length > 0) {
      throw new AgentProtocolError('MANIFEST_INVALID', 'Agent manifest does not pass the Draft 2020-12 schema', result.errors)
    }
    return result.manifest
  }

  validateEnvelope(value: unknown): ValidationIssue[] {
    const valid = this.protocol(value)
    return valid ? [] : issuesOf(this.protocol.errors)
  }

  assertEnvelope(value: unknown, direction: 'agent-to-host' | 'host-to-agent'): AgentEnvelope {
    const issues = this.validateEnvelope(value)
    if (issues.length > 0) {
      throw new AgentProtocolError('PROTOCOL_INVALID', 'Agent message does not pass protocol.schema.json', issues)
    }
    const envelope = value as AgentEnvelope
    const types = direction === 'agent-to-host' ? AGENT_TO_HOST_TYPES : HOST_TO_AGENT_TYPES
    if (!types.has(envelope.type)) {
      throw new AgentProtocolError('PROTOCOL_INVALID', `Type ${envelope.type} is forbidden in direction ${direction}`)
    }
    checkId(envelope.messageId, 'messageId')
    checkId(envelope.taskId, 'taskId')
    checkId(envelope.executionId, 'executionId')
    if (envelope.replyTo !== undefined) checkId(envelope.replyTo, 'replyTo')
    return envelope
  }

  assertTaskBinding(
    envelope: AgentEnvelope,
    expected: { taskId: string; executionId: string },
  ): void {
    if (envelope.taskId !== expected.taskId) {
      throw new AgentProtocolError('TASK_MISMATCH', 'Message belongs to another task')
    }
    if (envelope.executionId !== expected.executionId) {
      throw new AgentProtocolError('TASK_MISMATCH', 'Message belongs to another execution')
    }
  }

  assertProgress(payload: Record<string, unknown>): void {
    const completed = payload.completed
    const total = payload.total
    if (completed !== undefined || total !== undefined) {
      if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || Number(completed) > Number(total)) {
        throw new AgentProtocolError('PROTOCOL_INVALID', 'completed must be an integer no greater than total')
      }
    }
  }

  assertDecision(payload: Record<string, unknown>): void {
    if ((payload.decision === 'changes-requested' || payload.decision === 'rejected')
      && (typeof payload.comment !== 'string' || !/\S/u.test(payload.comment))) {
      throw new AgentProtocolError('INPUT_INVALID', 'A non-empty comment is required for revision or rejection')
    }
  }

  assertCheckpointFiles(payload: Record<string, unknown>): void {
    const files = payload.files
    if (!Array.isArray(files)) throw new AgentProtocolError('CHECKPOINT_INVALID', 'checkpoint.files must be an array')
    for (const entry of files) {
      const file = assertRecord(entry, 'checkpoint.files[]')
      checkRelativePath(file.path, 'checkpoint.files[].path')
      if (typeof file.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(file.checksum)) {
        throw new AgentProtocolError('CHECKPOINT_INVALID', 'checkpoint.files[].checksum must be SHA-256')
      }
    }
  }

  assertSafeId(value: unknown, label: string): string {
    return checkId(value, label)
  }
}
