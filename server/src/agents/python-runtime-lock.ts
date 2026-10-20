import fsp from 'node:fs/promises'
import path from 'node:path'
import { AgentPackageError } from './package-errors.js'
import { assertNoSymlinkAncestors } from './python-runtime-files.js'

/** Canonical in-process single-flight key for a portable runtime directory. */
export async function installKey(runtimeDir: string): Promise<string> {
  const absolute = path.resolve(runtimeDir)
  await assertNoSymlinkAncestors(absolute)
  let existing = absolute
  while (true) {
    const stat = await fsp.lstat(existing).catch((error: unknown) => {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return null
      throw error
    })
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AgentPackageError('RUNTIME_PATH_INVALID', 'Portable runtime path contains a symlink or is not a directory', 409)
      const canonical = await fsp.realpath(existing)
      return path.resolve(canonical, path.relative(existing, absolute)).toLocaleLowerCase('en-US')
    }
    const parent = path.dirname(existing)
    if (parent === existing) return absolute.toLocaleLowerCase('en-US')
    existing = parent
  }
}
