import crypto from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import type { RuntimeMetadata } from './package-check.js'
import { AgentPackageError } from './package-errors.js'

export type {
  PythonArchiveDownloadOptions,
  PythonRuntimeInstallerOptions,
  PythonRuntimeBaseline,
  PythonRuntimeMetadata,
  PythonRuntimeReceipt,
  PythonRuntimeResolveOptions,
  PythonRuntimeStatus,
  PythonRuntimeTree,
  PythonRuntimeVersionProbe,
  PythonRuntimeVersionProbeRequest,
} from './python-runtime.js'
export {
  MAX_RUNTIME_ARCHIVE_BYTES,
  MAX_RUNTIME_FILE_BYTES,
  MAX_RUNTIME_FILES,
  MAX_RUNTIME_TOTAL_BYTES,
  PORTABLE_PYTHON_VERSION,
  PORTABLE_PYTHON_ARCHIVE_URL,
  PORTABLE_PYTHON_ARCHIVE_SHA256,
  PYTHON_RUNTIME_ARCHIVE_FILE,
  PYTHON_RUNTIME_RECEIPT_FILE,
  downloadPythonRuntimeArchive,
  hashPythonRuntimeTree,
  inspectPythonRuntime,
  installPythonRuntime,
  pythonLaunch,
  requiredPythonRuntimeFiles,
  resolvePythonRuntime,
  runtimeRoot,
  sha256,
} from './python-runtime.js'

async function fileSha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function detectRuntimeMetadata(execPath = process.execPath): Promise<RuntimeMetadata> {
  const integrity = await fileSha256(execPath).catch(() => { throw new AgentPackageError('RUNTIME_INTEGRITY_UNAVAILABLE', 'Exact runtime integrity is unavailable', 500) })
  const environmentId = crypto.createHash('sha256').update(`${process.versions.node}\0${integrity}`).digest('hex').slice(0, 32)
  await fsPromises.access(execPath)
  return { kind: 'node', version: process.versions.node, integrity, environmentId }
}
