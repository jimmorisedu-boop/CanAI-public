import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PUBLIC_MANIFEST_NAME,
  PUBLIC_REVISION_NAME,
  PUBLIC_SOURCE_FORMAT,
  PUBLIC_SOURCE_VERSION,
  REQUIRED_SOURCE_FILES,
  REQUIRED_SOURCE_GROUPS,
  isPathInside,
  isPublicSourcePath,
  mapPublicPath,
  posixPath,
} from './public-release-config.mjs'
import { LOCAL_EDITION, LOCAL_OVERRIDE_ROOT, assertLocalEditionRuntime, localOverridePath, transformLocalEditionSource } from './local-edition.mjs'
import { renderHelpDocs } from './generate-help-docs.mjs'
import { projectArtifactsRoot } from './project-workspace.mjs'

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function git(args, root, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'encoding' in options ? options.encoding : 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function revisionFor(root) {
  return git(['rev-parse', '--verify', 'HEAD^{commit}'], root).trim()
}

function treeEntries(root, revision) {
  const raw = git(['ls-tree', '-r', '-z', '--full-tree', revision], root, { encoding: null })
  return raw.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t')
    const header = entry.slice(0, tab).split(' ')
    if (tab < 0 || header.length !== 3) throw new Error('git ls-tree returned an invalid entry')
    return { mode: header[0], type: header[1], hash: header[2], sourcePath: posixPath(entry.slice(tab + 1)) }
  })
}

async function lstatIfExists(target) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function assertNoSymlinkPath(target) {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = await lstatIfExists(current)
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink path: ${current}`)
  }
}

async function prepareOutput(root, output) {
  const target = path.resolve(output)
  if (isPathInside(root, target)) {
    const artifacts = projectArtifactsRoot(root)
    if (target === artifacts || !isPathInside(artifacts, target)) {
      throw new Error('Output directory must be outside the source repository or inside its ignored artifacts directory')
    }
    try {
      git(['check-ignore', '--quiet', '--', target], root)
    } catch {
      throw new Error('Output directory inside the source repository must be Git-ignored')
    }
  }
  await assertNoSymlinkPath(path.dirname(target))
  const stat = await lstatIfExists(target)
  if (stat?.isSymbolicLink()) throw new Error('Refusing symlink output directory')
  if (stat && !stat.isDirectory()) throw new Error('Output path is not a directory')
  if (stat && (await fs.readdir(target)).length > 0) throw new Error('Output directory must be new or empty')
  await fs.mkdir(target, { recursive: true })
  return target
}

function modeBits(mode) {
  const value = Number.parseInt(mode, 8)
  if (!Number.isInteger(value) || (value !== 0o100644 && value !== 0o100755)) {
    throw new Error(`Unsupported Git file mode ${mode}`)
  }
  return value & 0o777
}

function readPublicManifest(root, entries) {
  const entry = entries.find((candidate) => candidate.sourcePath === PUBLIC_MANIFEST_NAME)
  if (!entry) return { present: false, valid: false }
  if (entry.type !== 'blob' || entry.mode === '120000') {
    throw new Error('Refusing non-regular PUBLIC-SOURCE-MANIFEST.json')
  }
  let manifest
  try {
    manifest = JSON.parse(git(['cat-file', 'blob', entry.hash], root, { encoding: 'utf8' }))
  } catch {
    throw new Error('Invalid PUBLIC-SOURCE-MANIFEST.json')
  }
  if (manifest?.format !== PUBLIC_SOURCE_FORMAT || manifest?.version !== PUBLIC_SOURCE_VERSION || !Array.isArray(manifest.files)) {
    throw new Error('Invalid PUBLIC-SOURCE-MANIFEST.json')
  }
  if (manifest.edition !== undefined && manifest.edition !== LOCAL_EDITION) throw new Error('Invalid public source edition')
  return { present: true, valid: true, edition: manifest.edition }
}

async function writeBlob(root, output, entry, { transform }) {
  if (entry.type !== 'blob' || entry.mode === '120000') throw new Error(`Refusing non-regular tracked path: ${entry.sourcePath}`)
  const original = git(['cat-file', 'blob', entry.hash], root, { encoding: null })
  const destinationPath = entry.destinationPath
  const data = transform && !entry.override ? transformLocalEditionSource(destinationPath, original) : original
  assertLocalEditionRuntime(destinationPath, data)
  const destination = path.join(output, ...destinationPath.split('/'))
  if (!isPathInside(output, destination)) throw new Error(`Refusing path outside output directory: ${entry.sourcePath}`)
  await assertNoSymlinkPath(path.dirname(destination))
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, data)
  await fs.chmod(destination, modeBits(entry.mode))
  return {
    path: destinationPath,
    mode: entry.mode,
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  }
}

export async function exportPublicSource({ root = SCRIPT_ROOT, output }) {
  const sourceRoot = path.resolve(root)
  const sourceStat = await lstatIfExists(sourceRoot)
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Source repository must be a real directory')
  await assertNoSymlinkPath(sourceRoot)
  if (path.resolve(await fs.realpath(sourceRoot)) !== sourceRoot) throw new Error('Source repository path must resolve to itself')
  const revision = revisionFor(sourceRoot)
  const target = await prepareOutput(sourceRoot, output ?? path.join(projectArtifactsRoot(sourceRoot), 'public-source', revision.slice(0, 12)))
  const entries = treeEntries(sourceRoot, revision)
  const entryNames = new Set(entries.map((entry) => entry.sourcePath))
  const publicManifest = readPublicManifest(sourceRoot, entries)
  const hasAuthoringPublicDocs = REQUIRED_SOURCE_GROUPS.some(([authoringPath]) => entryNames.has(authoringPath))
  const reexportAliases = new Set(REQUIRED_SOURCE_GROUPS.flatMap(([, publicPath]) => [publicPath]))
  const allowReexportAliases = publicManifest.valid && !hasAuthoringPublicDocs
  const regenerateHelp = entryNames.has('client/src/help/content/guide.json')
  const selectedByPath = new Map()
  for (const entry of entries) {
    if (entry.sourcePath.startsWith(LOCAL_OVERRIDE_ROOT)) continue
    if (!isPublicSourcePath(entry.sourcePath)) continue
    if (regenerateHelp && entry.sourcePath.startsWith('docs/help/')) continue
    if (reexportAliases.has(entry.sourcePath) && !allowReexportAliases) continue
    const destinationPath = mapPublicPath(entry.sourcePath)
    selectedByPath.set(destinationPath, { ...entry, destinationPath })
  }
  for (const entry of entries) {
    const destinationPath = localOverridePath(entry.sourcePath)
    if (!destinationPath) continue
    if (!isPublicSourcePath(destinationPath)) throw new Error(`Override target is not public: ${destinationPath}`)
    selectedByPath.set(destinationPath, { ...entry, destinationPath, override: true })
  }
  const selected = [...selectedByPath.values()]
  const selectedNames = new Set(selected.map((entry) => entry.destinationPath))
  for (const required of REQUIRED_SOURCE_FILES) {
    if (!selectedNames.has(required)) throw new Error(`Required public source file is missing: ${required}`)
  }
  const availablePublicPaths = new Set([...selectedNames, ...selected.map((entry) => entry.destinationPath)])
  for (const group of REQUIRED_SOURCE_GROUPS) {
    if (!group.some((sourcePath) => availablePublicPaths.has(sourcePath))) {
      throw new Error(`Required public source file is missing: ${group.join(' or ')}`)
    }
  }

  const manifestFiles = []
  for (const entry of selected) manifestFiles.push(await writeBlob(sourceRoot, target, entry, { transform: publicManifest.edition !== LOCAL_EDITION }))
  // Help Markdown derives from the edition's final guide, not the full
  // development guide. Record the generated bytes in the same source manifest.
  if (regenerateHelp) {
    const guide = JSON.parse(await fs.readFile(path.join(target, 'client/src/help/content/guide.json'), 'utf8'))
    await fs.mkdir(path.join(target, 'docs/help'), { recursive: true })
    for (const [name, content] of Object.entries(renderHelpDocs(guide))) {
      const filename = `docs/help/${name}`
      if (!isPublicSourcePath(filename)) throw new Error(`Invalid generated Help path: ${filename}`)
      const data = Buffer.from(content)
      await fs.writeFile(path.join(target, filename), data)
      manifestFiles.push({ path: filename, mode: '100644', bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') })
    }
  }
  manifestFiles.sort((a, b) => a.path.localeCompare(b.path))
  const manifest = {
    format: PUBLIC_SOURCE_FORMAT,
    version: PUBLIC_SOURCE_VERSION,
    edition: LOCAL_EDITION,
    sourceRevision: revision,
    files: manifestFiles,
  }
  await fs.writeFile(path.join(target, PUBLIC_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fs.writeFile(path.join(target, PUBLIC_REVISION_NAME), `${revision}\n`, 'utf8')
  return { output: target, sourceRevision: revision, files: manifestFiles }
}

function parseArgs(argv) {
  const options = { root: SCRIPT_ROOT, output: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') options.root = argv[++index]
    else if (arg === '--output' || arg === '--out') options.output = argv[++index]
    else if (!arg.startsWith('-') && !options.output) options.output = arg
    else if (arg === '--help' || arg === '-h') return null
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function usage() {
  return 'Usage: node scripts/export-public-source.mjs [--output <new-or-empty-dir>] [--root <repo>] (default: artifacts/public-source/<revision>)'
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (!options) {
      console.log(usage())
    } else {
      const result = await exportPublicSource(options)
      console.log(`Exported ${result.files.length} files at ${result.sourceRevision} to ${result.output}`)
    }
  } catch (error) {
    console.error(`[public-source] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
