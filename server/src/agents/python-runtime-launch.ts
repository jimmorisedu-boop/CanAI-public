import fs from 'node:fs'
import path from 'node:path'
import { AgentPackageError } from './package-errors.js'
import { PORTABLE_PYTHON_ARCHIVE_SHA256, relativeSafe, runtimeRoot, type PythonRuntimeMetadata } from './python-runtime-files.js'

function lstatOrInvalid(file: string, label: string): fs.Stats {
  try { return fs.lstatSync(file) }
  catch { throw new AgentPackageError('RUNTIME_PATH_INVALID', `${label} is unavailable`, 409) }
}

function assertNoSymlinkAncestorsSync(target: string): void {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  const parts = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)
  for (const part of parts) {
    current = path.join(current, part)
    let stat: fs.Stats
    try { stat = fs.lstatSync(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime path is unavailable', 409)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime path contains a symlink or is not a directory', 409)
  }
}

function portableEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
  env.PYTHONNOUSERSITE = '1'
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  return env
}

function safePackagePath(packageRoot: string, entrypoint: string): { root: string; entry: string } {
  if (!path.isAbsolute(packageRoot) || !path.isAbsolute(entrypoint)) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python packageRoot and entrypoint must be absolute', 409)
  if (packageRoot.split(/[\\/]/u).includes('..') || entrypoint.split(/[\\/]/u).includes('..')) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python entrypoint contains traversal', 409)
  const root = path.resolve(packageRoot)
  const entry = path.resolve(entrypoint)
  if (!relativeSafe(root, entry)) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python entrypoint is outside packageRoot', 409)
  assertNoSymlinkAncestorsSync(root)
  assertNoSymlinkAncestorsSync(path.dirname(entry))
  const rootStat = lstatOrInvalid(root, 'Python packageRoot')
  const entryStat = lstatOrInvalid(entry, 'Python entrypoint')
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !entryStat.isFile() || entryStat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python packageRoot/entrypoint contains a symlink or special file', 409)
  let rootReal: string
  let entryReal: string
  try {
    rootReal = fs.realpathSync.native(root)
    entryReal = fs.realpathSync.native(entry)
  } catch { throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python packageRoot/entrypoint realpath is unavailable', 409) }
  if (!relativeSafe(rootReal, entryReal)) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python entrypoint realpath is outside packageRoot', 409)
  return { root, entry }
}

/**
 * Pure launch-plan builder. Callers must obtain `runtime` from a fresh
 * inspect/resolve verification immediately before this function; it does not
 * hash files, read receipts, or spawn a process itself.
 */
export function pythonLaunch(runtime: PythonRuntimeMetadata, runtimeDir: string, entrypoint: string, module = false, packageRoot?: string): { executable: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv } {
  const root = runtimeRoot(runtimeDir)
  assertNoSymlinkAncestorsSync(path.resolve(runtimeDir))
  const runtimeDirStat = lstatOrInvalid(path.resolve(runtimeDir), 'Portable runtime directory')
  if (!runtimeDirStat.isDirectory() || runtimeDirStat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime directory contains a symlink', 409)
  const rootStat = lstatOrInvalid(root, 'Python runtime root')
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python runtime root contains a symlink', 409)
  if (!runtime || runtime.kind !== 'python' || runtime.archiveSha !== PORTABLE_PYTHON_ARCHIVE_SHA256) throw new AgentPackageError('RUNTIME_BASELINE_REQUIRED', 'Python launch requires a verified install receipt', 409)
  if (runtime.executableRelative !== 'python.exe' || runtime.executableRelative.includes('/') || runtime.executableRelative.includes('\\')) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python executableRelative is invalid', 409)
  const executable = path.resolve(root, runtime.executableRelative)
  const executableStat = lstatOrInvalid(executable, 'Portable Python executable')
  if (!relativeSafe(root, executable) || !executableStat.isFile() || executableStat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python executable is outside the runtime root', 409)
  const baseArgs = ['-I', '-S', '-B', '-u', '-X', 'utf8']
  if (!packageRoot) throw new AgentPackageError('RUNTIME_PACKAGE_ROOT_REQUIRED', 'Python launch requires an immutable packageRoot', 409)
  if (module && !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(entrypoint)) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python module entrypoint is invalid', 409)
  const moduleRelative = entrypoint.split('.').join(path.sep)
  const moduleCandidates = [path.join(packageRoot, moduleRelative, '__main__.py'), path.join(packageRoot, `${moduleRelative}.py`)]
  const moduleEntrypoint = moduleCandidates.find((candidate) => fs.existsSync(candidate))
  if (module && !moduleEntrypoint) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Python module entrypoint was not found in packageRoot', 409)
  const paths = safePackagePath(packageRoot, module ? moduleEntrypoint! : entrypoint)
  const code = module
    ? `import runpy,sys;sys.path.insert(0,${JSON.stringify(paths.root)});runpy.run_module(${JSON.stringify(entrypoint)},run_name="__main__")`
    : `import runpy,sys;sys.path.insert(0,${JSON.stringify(paths.root)});runpy.run_path(${JSON.stringify(paths.entry)},run_name="__main__")`
  return { executable, args: [...baseArgs, '-c', code], cwd: paths.root, env: portableEnvironment() }
}
