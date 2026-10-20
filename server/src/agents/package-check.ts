import fs from 'node:fs/promises'
import path from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { AgentInputField, AgentInputSchemaView, AgentPackageIssue, AgentPackageManifestView } from '../../../packages/agent-protocol/index.js'
import { AgentProtocolError, AgentProtocolValidator, checkRelativePath } from './validation.js'
import { normalizeManifest, type AgentManifest } from './packages.js'
import { packageTreeIntegrity } from './package-archive.js'
import { AgentPackageError } from './package-errors.js'

const SUPPORTED_PERMISSIONS = new Set(['artifact.publish', 'canvas.create_results', 'canvas.read_selected', 'review.request', 'llm.request', 'generation.request', 'media.read', 'media.render'])
const LOCAL_FAL_CONNECTION = 'local-fal'
const FORM_KEYS = new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'enum', 'default'])

export interface RuntimeMetadata {
  kind?: 'node' | 'python'
  version: string
  integrity: string
  environmentId: string
}

export interface CheckedPackage {
  root: string
  manifest: AgentManifest
  manifestView: AgentPackageManifestView
  packageSha: string
  entrypoint: string
  entrypointKind: 'file' | 'module'
  entrypointModule?: string
  inputValidators: Map<string, ValidateFunction>
  issues: AgentPackageIssue[]
}

function issue(code: string, message: string, pathName?: string, severity: AgentPackageIssue['severity'] = 'error'): AgentPackageIssue {
  return { code, message, ...(pathName ? { path: pathName } : {}), severity }
}

function versionPair(value: string): [number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2])] : null
}

function compatibleRuntime(required: string, actual: string): boolean {
  const expected = versionPair(required)
  const current = versionPair(actual)
  if (!expected || !current) return false
  return current[0] > expected[0] || (current[0] === expected[0] && current[1] >= expected[1])
}

export function formForSchema(schema: unknown): AgentInputSchemaView | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const root = schema as Record<string, unknown>
  if (root.type !== 'object' || root.additionalProperties === true || !root.properties || typeof root.properties !== 'object' || Array.isArray(root.properties)) return undefined
  if (Object.keys(root).some((key) => !FORM_KEYS.has(key) && key !== '$schema')) return undefined
  if (root.required !== undefined && !Array.isArray(root.required)) return undefined
  const requiredValues = Array.isArray(root.required) ? root.required.filter((value): value is string => typeof value === 'string') : []
  const required = new Set(requiredValues)
  const propertyKeys = new Set(Object.keys(root.properties as Record<string, unknown>))
  if (requiredValues.length !== required.size || [...required].some((key) => !propertyKeys.has(key))) return undefined
  const fields: AgentInputSchemaView['fields'] = []
  for (const [key, raw] of Object.entries(root.properties as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const value = raw as Record<string, unknown>
    if (Object.keys(value).some((entry) => !FORM_KEYS.has(entry) && entry !== '$schema')) return undefined
    const type = value.type
    const kind = type === 'integer' || type === 'number' ? 'number' : type === 'string' || type === 'boolean' ? type : null
    if (!kind || (value.enum !== undefined && (type !== 'string' || !Array.isArray(value.enum) || value.enum.length > 32 || value.enum.some((entry) => typeof entry !== 'string')))) return undefined
    if (value.default !== undefined && ((kind === 'string' && typeof value.default !== 'string') || (kind === 'number' && (typeof value.default !== 'number' || !Number.isFinite(value.default) || (type === 'integer' && !Number.isInteger(value.default)))) || (kind === 'boolean' && typeof value.default !== 'boolean'))) return undefined
    if (value.enum && value.default !== undefined && !value.enum.includes(value.default)) return undefined
    if (value.minimum !== undefined && (kind !== 'number' || typeof value.minimum !== 'number' || !Number.isFinite(value.minimum) || (type === 'integer' && !Number.isInteger(value.minimum)))) return undefined
    if (value.maximum !== undefined && (kind !== 'number' || typeof value.maximum !== 'number' || !Number.isFinite(value.maximum) || (type === 'integer' && !Number.isInteger(value.maximum)))) return undefined
    if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) return undefined
    if (value.minLength !== undefined && (kind !== 'string' || !Number.isSafeInteger(value.minLength) || Number(value.minLength) < 0)) return undefined
    if (value.maxLength !== undefined && (kind !== 'string' || !Number.isSafeInteger(value.maxLength) || Number(value.maxLength) < 0)) return undefined
    if (typeof value.minLength === 'number' && typeof value.maxLength === 'number' && value.minLength > value.maxLength) return undefined
    const field: AgentInputField = {
      key,
      ...(typeof value.title === 'string' ? { label: value.title.slice(0, 120) } : {}),
      ...(typeof value.description === 'string' ? { description: value.description.slice(0, 500) } : {}),
      kind: value.enum ? 'enum' as const : kind,
      ...(kind === 'number' && type === 'integer' ? { integer: true } : {}),
      ...(required.has(key) ? { required: true } : {}),
      ...(Array.isArray(value.enum) ? { enum: value.enum as string[] } : {}),
      ...(typeof value.default === 'string' || typeof value.default === 'number' || typeof value.default === 'boolean' ? { default: value.default } : {}),
      ...(typeof value.minimum === 'number' && Number.isFinite(value.minimum) ? { minimum: value.minimum } : {}),
      ...(typeof value.maximum === 'number' && Number.isFinite(value.maximum) ? { maximum: value.maximum } : {}),
      ...(Number.isSafeInteger(value.minLength) && Number(value.minLength) >= 0 ? { minLength: value.minLength as number } : {}),
      ...(Number.isSafeInteger(value.maxLength) && Number(value.maxLength) >= 0 ? { maxLength: value.maxLength as number } : {}),
    }
    fields.push(field)
  }
  return { type: 'object', fields }
}

function manifestView(manifest: AgentManifest, schemas: Map<string, unknown>): AgentPackageManifestView {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    protocolVersion: manifest.protocolVersion,
    taskTypes: manifest.taskTypes.map((task) => ({
      id: task.id,
      label: task.label,
      description: task.description,
      outputKinds: [...task.outputKinds],
      ...(task.generation ? { generation: { kinds: [...task.generation.kinds], maxCalls: task.generation.maxCalls } } : {}),
      ...(task.llmCalls !== undefined ? { llmCalls: task.llmCalls } : {}),
      ...(formForSchema(schemas.get(task.id)) ? { inputSchema: formForSchema(schemas.get(task.id)) } : {}),
    })),
    permissions: [...manifest.permissions],
    lifecycle: manifest.lifecycle,
    runtime: {
      kind: manifest.runtime.kind,
      version: manifest.runtime.version,
      entrypoint: manifest.runtime.entrypoint.kind === 'file' ? manifest.runtime.entrypoint.path : manifest.runtime.entrypoint.module,
      dependencies: manifest.runtime.dependencies.kind,
    },
  }
}

async function regularFile(root: string, relative: string, label: string): Promise<string> {
  try { checkRelativePath(relative, label) } catch { throw new AgentPackageError('MANIFEST_INVALID', `${label} must be a relative path`) }
  const rootReal = await fs.realpath(root)
  const absolute = path.resolve(root, relative)
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new AgentPackageError('MANIFEST_INVALID', `${label} is outside the package`)
  const real = await fs.realpath(absolute).catch(() => '')
  if (!real || !real.startsWith(`${rootReal}${path.sep}`)) throw new AgentPackageError('PACKAGE_INTEGRITY_INVALID', `${label} is outside the package`)
  const stat = await fs.lstat(real)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AgentPackageError('MANIFEST_INVALID', `${label} must be a regular file`)
  return real
}

async function pythonModule(root: string, module: string): Promise<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(module)) throw new AgentPackageError('MANIFEST_INVALID', 'runtime.entrypoint.module is invalid')
  const relative = module.split('.').join('/')
  const packageMain = await fs.realpath(path.join(root, relative, '__main__.py')).catch(() => '')
  if (packageMain) return regularFile(root, `${relative}/__main__.py`, 'runtime.entrypoint.module')
  const moduleFile = await fs.realpath(path.join(root, `${relative}.py`)).catch(() => '')
  if (moduleFile) return regularFile(root, `${relative}.py`, 'runtime.entrypoint.module')
  throw new AgentPackageError('MANIFEST_INVALID', 'Python module entrypoint was not found')
}

async function boundedJson(file: string, label: string, maxBytes: number): Promise<unknown> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile() || stat.size > maxBytes) throw new AgentPackageError('INPUT_SCHEMA_INVALID', `${label} exceeds the size limit`)
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as unknown }
  catch { throw new AgentPackageError('INPUT_SCHEMA_INVALID', `${label} is not JSON`) }
}

export async function checkPackage(root: string, validator: AgentProtocolValidator, runtime?: RuntimeMetadata): Promise<CheckedPackage> {
  let raw: unknown
  try { raw = await boundedJson(path.join(root, 'canai.agent.json'), 'canai.agent.json', 256 * 1024) }
  catch (error) {
    if (error instanceof AgentPackageError && error.code === 'INPUT_SCHEMA_INVALID') throw new AgentPackageError('MANIFEST_INVALID', error.message)
    throw new AgentPackageError('MANIFEST_MISSING', 'Package is missing canai.agent.json')
  }
  let manifest: AgentManifest
  try { manifest = normalizeManifest(validator.assertManifest(raw)) }
  catch (error) {
    if (error instanceof AgentProtocolError) throw new AgentPackageError(error.code, error.message)
    throw error
  }
  const tree = await packageTreeIntegrity(root)
  const issues: AgentPackageIssue[] = []
  const actualKind = runtime?.kind ?? 'node'
  if (manifest.runtime.kind !== actualKind) issues.push(issue('RUNTIME_UNAVAILABLE', `Package requires ${manifest.runtime.kind} runtime, available ${runtime ? actualKind : 'is not installed'}`, 'runtime.kind'))
  if (manifest.runtime.kind === 'node' && manifest.runtime.entrypoint.kind !== 'file') issues.push(issue('ENTRYPOINT_UNSUPPORTED', 'Node supports only a file entrypoint', 'runtime.entrypoint.kind'))
  if (manifest.runtime.dependencies.kind !== 'stdlib') issues.push(issue('DEPENDENCIES_UNSUPPORTED', 'v1 supports only stdlib dependencies', 'runtime.dependencies.kind'))
  if (manifest.runtime.maxParallelTasks !== 1) issues.push(issue('PARALLELISM_UNSUPPORTED', 'Package must declare maxParallelTasks=1', 'runtime.maxParallelTasks'))
  if (!runtime || !compatibleRuntime(manifest.runtime.version, runtime.version)) issues.push(issue('RUNTIME_VERSION_UNSUPPORTED', `Package requires ${manifest.runtime.kind} ${manifest.runtime.version}, available ${runtime?.version ?? 'is not installed'}`, 'runtime.version'))
  for (const permission of manifest.permissions) if (!SUPPORTED_PERMISSIONS.has(permission)) issues.push(issue('PERMISSION_UNSUPPORTED', `Permission ${permission} is not supported by this Host`, 'permissions'))
  const requestsLlm = manifest.permissions.includes('llm.request')
  if (manifest.connections.length > 2) issues.push(issue('CONNECTIONS_UNSUPPORTED', 'At most one connection of each local fal type is supported', 'connections'))
  for (const connection of manifest.connections) {
    if (connection.id !== LOCAL_FAL_CONNECTION || (connection.kind !== 'llm' && connection.kind !== 'generation') || connection.required !== true) {
      issues.push(issue('CONNECTION_UNSUPPORTED', 'Only a required authenticated local-fal connection of kind=llm or generation is allowed', 'connections'))
    }
  }
  const hasLocalLlm = manifest.connections.some((connection) => connection.id === LOCAL_FAL_CONNECTION && connection.kind === 'llm' && connection.required === true)
  const hasLocalGeneration = manifest.connections.some((connection) => connection.id === LOCAL_FAL_CONNECTION && connection.kind === 'generation' && connection.required === true)
  if (requestsLlm && !hasLocalLlm) issues.push(issue('LLM_CONNECTION_REQUIRED', 'Permission llm.request requires a required local-fal connection of kind=llm', 'connections'))
  if (!requestsLlm && hasLocalLlm) issues.push(issue('LLM_PERMISSION_REQUIRED', 'A local-fal connection of kind=llm cannot be declared without permission llm.request', 'permissions'))
  const requestsGeneration = manifest.permissions.includes('generation.request')
  if (requestsGeneration && !hasLocalGeneration) issues.push(issue('GENERATION_CONNECTION_REQUIRED', 'Permission generation.request requires a required local-fal connection of kind=generation', 'connections'))
  if (!requestsGeneration && hasLocalGeneration) issues.push(issue('GENERATION_PERMISSION_REQUIRED', 'A local-fal connection of kind=generation cannot be declared without permission generation.request', 'permissions'))
  const connectionKeys = manifest.connections.map((connection) => `${connection.id}:${connection.kind}`)
  if (new Set(connectionKeys).size !== connectionKeys.length) issues.push(issue('CONNECTIONS_UNSUPPORTED', 'Only one local-fal connection of each type is allowed', 'connections'))
  for (const task of manifest.taskTypes) {
    if (task.generation && !requestsGeneration) {
      issues.push(issue('GENERATION_PERMISSION_REQUIRED', `taskTypes.${task.id}.generation requires permission generation.request`, `taskTypes.${task.id}.generation`))
    }
    if (task.llmCalls !== undefined && !requestsLlm) {
      issues.push(issue('LLM_PERMISSION_REQUIRED', `taskTypes.${task.id}.llmCalls requires permission llm.request`, `taskTypes.${task.id}.llmCalls`))
    }
  }
  const schemas = new Map<string, unknown>()
  const inputValidators = new Map<string, ValidateFunction>()
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
  addFormats(ajv)
  let entrypoint = ''
  let entrypointKind: CheckedPackage['entrypointKind'] = 'file'
  let entrypointModule: string | undefined
  if (manifest.runtime.entrypoint.kind === 'file') entrypoint = await regularFile(root, manifest.runtime.entrypoint.path, 'runtime.entrypoint.path')
  else {
    entrypointKind = 'module'
    entrypointModule = manifest.runtime.entrypoint.module
    if (manifest.runtime.kind === 'python') entrypoint = await pythonModule(root, entrypointModule)
  }
  for (const task of manifest.taskTypes) {
    const schemaPath = await regularFile(root, task.inputSchema, `taskTypes.${task.id}.inputSchema`)
    const schema = await boundedJson(schemaPath, `Input schema ${task.id}`, 256 * 1024)
    const form = formForSchema(schema)
    if (!form) issues.push(issue('INPUT_FORM_UNSUPPORTED', `For ${task.id} has no safe data-only form`, `taskTypes.${task.id}.inputSchema`))
    try { inputValidators.set(task.id, ajv.compile(schema as object)) }
    catch { throw new AgentPackageError('INPUT_SCHEMA_INVALID', `Input schema ${task.id} is not supported by Draft 2020-12`) }
    schemas.set(task.id, schema)
  }
  return { root, manifest, manifestView: manifestView(manifest, schemas), packageSha: tree.packageSha, entrypoint, entrypointKind, ...(entrypointModule ? { entrypointModule } : {}), inputValidators, issues }
}

export function supportedPackage(check: CheckedPackage): boolean { return !check.issues.some((entry) => entry.severity === 'error') }

export function supportedPermissions(): string[] { return [...SUPPORTED_PERMISSIONS].sort() }
