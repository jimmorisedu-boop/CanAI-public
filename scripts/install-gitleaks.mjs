import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const GITLEAKS_VERSION = '8.30.1'
const RELEASE_BASE = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`
export const GITLEAKS_ASSETS = Object.freeze({
  'win32-x64': { archive: 'gitleaks_8.30.1_windows_x64.zip', sha256: 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e', kind: 'zip', binary: 'gitleaks.exe' },
  'linux-x64': { archive: 'gitleaks_8.30.1_linux_x64.tar.gz', sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb', kind: 'tar', binary: 'gitleaks' },
  'darwin-arm64': { archive: 'gitleaks_8.30.1_darwin_arm64.tar.gz', sha256: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5', kind: 'tar', binary: 'gitleaks' },
})

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

export function assetForPlatform(platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch)
  const asset = GITLEAKS_ASSETS[key]
  if (!asset) throw new Error(`Gitleaks ${GITLEAKS_VERSION} has no pinned asset for ${key}`)
  return { key, ...asset, url: `${RELEASE_BASE}/${asset.archive}` }
}

export function resolveGitleaksBinary(output, platform = process.platform, arch = process.arch) {
  return path.join(path.resolve(output), assetForPlatform(platform, arch).binary)
}

async function download(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('This Node runtime has no fetch implementation')
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`Gitleaks download failed with HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function verifyArchive(data, expected) {
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== expected) throw new Error(`Gitleaks archive checksum mismatch: expected ${expected}, got ${actual}`)
}

function archiveEntries(archive) {
  try {
    return execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split(/\r?\n/u).filter(Boolean)
  } catch {
    return []
  }
}

function assertSafeArchiveEntries(entries) {
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`Refusing unsafe Gitleaks archive entry: ${entry}`)
    }
  }
}

async function findBinary(root, name) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = await findBinary(target, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) return target
  }
  return null
}

async function removeOwnedTemporaryDirectory(target) {
  const absolute = path.resolve(target)
  const tempRoot = path.resolve(os.tmpdir())
  const lexicalRelative = path.relative(tempRoot, absolute)
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative) || !path.basename(absolute).startsWith('canai-gitleaks-')) {
    throw new Error(`Refusing to remove unexpected temporary path: ${target}`)
  }
  let stat
  try {
    stat = await fs.lstat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to remove symlink temporary path: ${target}`)
  const realRoot = await fs.realpath(tempRoot)
  const realTarget = await fs.realpath(absolute)
  const realRelative = path.relative(realRoot, realTarget)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`Refusing to remove temporary path outside the system temp directory: ${target}`)
  }
  await fs.rm(absolute, { recursive: true, force: true })
}

async function extractArchive(data, asset, destination) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-gitleaks-'))
  try {
    const archive = path.join(temp, asset.archive)
    const extracted = path.join(temp, 'extracted')
    await fs.mkdir(extracted)
    await fs.writeFile(archive, data)
    if (asset.kind === 'tar') {
      assertSafeArchiveEntries(archiveEntries(archive))
      execFileSync('tar', ['-xzf', archive, '-C', extracted])
    } else {
      // Native PowerShell does not populate `$args` for trailing arguments
      // passed after a `-Command` string. Pass the validated temp paths through
      // the child environment instead of interpolating them into shell code.
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:CANAI_GITLEAKS_ARCHIVE -DestinationPath $env:CANAI_GITLEAKS_DEST -Force',
      ], {
        env: {
          ...process.env,
          CANAI_GITLEAKS_ARCHIVE: archive,
          CANAI_GITLEAKS_DEST: extracted,
        },
      })
    }
    const binary = await findBinary(extracted, asset.binary)
    if (!binary) throw new Error('Downloaded Gitleaks archive did not contain its pinned binary')
    await fs.mkdir(destination, { recursive: true })
    const target = path.join(path.resolve(destination), asset.binary)
    await fs.copyFile(binary, target)
    await fs.chmod(target, 0o755)
    return target
  } finally {
    await removeOwnedTemporaryDirectory(temp)
  }
}

export async function installGitleaks({ output, platform = process.platform, arch = process.arch, fetchImpl } = {}) {
  if (!output) throw new Error('An explicit --output directory is required')
  const asset = assetForPlatform(platform, arch)
  const data = await download(asset.url, fetchImpl)
  verifyArchive(data, asset.sha256)
  return extractArchive(data, asset, path.resolve(output))
}

function parseArgs(argv) {
  const options = { output: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--output' || arg === '--out') options.output = argv[++index]
    else if (arg === '--help' || arg === '-h') return null
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (!options) console.log('Usage: node scripts/install-gitleaks.mjs --output <tool-dir>')
    else console.log(`binary: ${await installGitleaks(options)}`)
  } catch (error) {
    console.error(`[gitleaks] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
