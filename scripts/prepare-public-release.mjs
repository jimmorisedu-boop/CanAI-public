import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exportPublicSource } from './export-public-source.mjs'
import {
  assertAuthoringCheckout,
  assertDisjointPaths,
  assertNoSymlinkPath,
  assertPublicCheckout,
  lstatOrNull,
  readVersion,
  shortRevision,
} from './prepare-public-release-guards.mjs'
import {
  archiveSource,
  assertNoSharedHistory,
  createCandidate,
  git,
  publishCandidate,
  syncCandidate,
  verifyCandidateManifest,
} from './prepare-public-release-git.mjs'
import {
  extractZip,
  packageZip,
  resolveGitleaks,
  runNativePackage,
  runNpmGates,
  runNpmInstall,
  runSecretScan,
  runSmoke,
} from './prepare-public-release-steps.mjs'
import {
  copyArtifacts,
  assertReusableArtifact,
  assertLatestPointerReady,
  sha256File,
  writeLatestPointer,
} from './prepare-public-release-artifacts.mjs'
import { GITLEAKS_VERSION } from './install-gitleaks.mjs'
import { makeProjectTemp, removeProjectTemp } from './project-workspace.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')

function usage() {
  return [
    'Usage: npm run release:prepare -- [options]',
    '',
    'Options:',
    '  --root <dir>          private authoring checkout (default: current repository)',
    '  --public <dir>        canonical public checkout (default: ../CanAI-public)',
    '  --artifact-root <dir> release artifacts (default: artifacts/public-release)',
    '  --platform windows|macos  native package target (default: host)',
    '  --gitleaks <path>     verified Gitleaks 8.30.1 binary',
    '  --source-only         skip native package and smoke, keep all source gates',
    '  --help                show this help',
    '',
    'Temporary release workspaces: <root>/artifacts/.tmp/',
  ].join('\n')
}

export function parseArgs(argv, cwd = ROOT) {
  const options = {
    root: cwd,
    publicRoot: null,
    artifactRoot: null,
    platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : null,
    gitleaks: null,
    sourceOnly: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--source-only') options.sourceOnly = true
    else if (arg === '--root') options.root = path.resolve(requiredValue(argv, ++index, arg))
    else if (arg === '--public') options.publicRoot = path.resolve(requiredValue(argv, ++index, arg))
    else if (arg === '--artifact-root') options.artifactRoot = path.resolve(requiredValue(argv, ++index, arg))
    else if (arg === '--platform') options.platform = requiredValue(argv, ++index, arg)
    else if (arg === '--gitleaks') options.gitleaks = requiredValue(argv, ++index, arg)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  options.publicRoot ??= path.resolve(options.root, '..', 'CanAI-public')
  options.artifactRoot ??= path.resolve(options.root, 'artifacts', 'public-release')
  if (!options.platform && !options.sourceOnly && !options.help) throw new Error('Unsupported host platform; pass --platform windows or --platform macos')
  if (options.platform && options.platform !== 'windows' && options.platform !== 'macos') throw new Error(`Unsupported release platform: ${options.platform}`)
  return options
}

function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`)
  return value
}

function pinnedNode(root) {
  const candidates = process.platform === 'win32'
    ? [path.join(root, 'runtime', 'node', 'node.exe')]
    : [path.join(root, 'runtime', 'node', 'bin', 'node')]
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
      if (version === 'v22.23.1') return candidate
      throw new Error(`Portable Node must be v22.23.1, found ${version}`)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      if (error instanceof Error && /Portable Node/u.test(error.message)) throw error
      throw error
    }
  }
  if (process.version !== 'v22.23.1') throw new Error('Portable Node v22.23.1 is required; add runtime/node or invoke this command with Node v22.23.1')
  return process.execPath
}

function maybeReexecWithPinnedNode(options) {
  if (process.env.CANAI_RELEASE_NODE_HANDOFF === '1' || options.help) return null
  const candidate = pinnedNode(options.root)
  if (path.resolve(candidate) === path.resolve(process.execPath)) return null
  const result = spawnSync(candidate, [SCRIPT_PATH, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, CANAI_RELEASE_NODE_HANDOFF: '1' },
    windowsHide: false,
  })
  return result.status ?? 1
}

async function writeHashFile(file) {
  const hash = await sha256File(file)
  await fs.writeFile(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`, 'utf8')
  return hash
}

export async function preparePublicRelease(options, hooks = {}) {
  const root = path.resolve(options.root)
  const publicRoot = path.resolve(options.publicRoot)
  const artifactRoot = path.resolve(options.artifactRoot)
  let stage = null
  let candidateRoot = null
  const progress = hooks.progress ?? ((message) => console.log(`[release] ${message}`))
  try {
    await assertAuthoringCheckout(root)
    await assertDisjointPaths({ sourceRoot: root, publicRoot, artifactRoot })
    const version = await readVersion(root)
    const fullRevision = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
    const revision = shortRevision(root)
    const runSuffix = options.sourceOnly ? '-source-only' : ''
    const artifactDirectory = path.join(artifactRoot, `${version}-${revision}${runSuffix}`)
    await assertNoSymlinkPath(path.dirname(artifactDirectory))
    const pointerName = options.sourceOnly ? 'latest-source.json' : 'latest.json'
    // Check the destination before any source export, candidate commit, or
    // artifact work. A regular pointer may be replaced atomically; symlinks,
    // directories, and non-directory roots are never release destinations.
    await assertLatestPointerReady({ artifactRoot, pointerName })
    const publicInfo = await assertPublicCheckout(publicRoot)
    if (publicInfo.exists) assertNoSharedHistory(root, publicRoot)
    const nodePath = hooks.nodePath ?? pinnedNode(root)
    stage = await makeProjectTemp(root, 'canai-release-prepare-')
    progress(`stage workspace: ${stage}`)
    const exportRoot = path.join(stage, 'source')
    const logs = path.join(stage, 'logs')
    const stagedArtifact = path.join(stage, 'artifact')
    await fs.mkdir(stagedArtifact, { recursive: true })
    const exporter = hooks.exporter ?? exportPublicSource
    progress('exporting committed public source')
    const exporterResult = await exporter({ root, output: exportRoot })
    if (exporterResult.sourceRevision && exporterResult.sourceRevision !== fullRevision) {
      throw new Error('Public export revision changed while the release was running')
    }
    const gitleaks = await resolveGitleaks({
      explicit: options.gitleaks,
      workspace: stage,
      install: hooks.installGitleaks,
      verifyBinary: hooks.verifyGitleaks,
    })
    progress(`required Gitleaks ${GITLEAKS_VERSION} ready`)
    await runSecretScan({ workspace: exportRoot, gitleaks, nodePath, runner: hooks.runner, logs })
    progress('source checks, tests, and audits')
    await runNpmGates({ workspace: exportRoot, nodePath, runner: hooks.runner, logs })

    candidateRoot = path.join(stage, 'candidate')
    await createCandidate({ publicRoot, candidateRoot, publicInfo })
    const candidate = await syncCandidate({ exportRoot, candidateRoot })
    progress(`candidate commit: ${candidate.commit}`)
    verifyCandidateManifest({ candidateRoot, manifest: candidate.manifest })
    await runSecretScan({ workspace: candidateRoot, gitleaks, nodePath, runner: hooks.runner, logs, mode: 'git' })
    const sourceZip = path.join(stagedArtifact, `CanAI-${version}-source.zip`)
    await archiveSource({ candidateRoot, version, destination: sourceZip })
    const sourceHash = await writeHashFile(sourceZip)
    let packagePath = null
    let packageHash = null
    if (!options.sourceOnly) {
      progress(`building ${options.platform} package`)
      await runNpmInstall({ workspace: candidateRoot, nodePath, runner: hooks.runner, logs })
      await runNativePackage({ workspace: candidateRoot, platform: options.platform, gitleaks, nodePath, runner: hooks.runner, logs })
      const builtZip = await packageZip(candidateRoot)
      packagePath = path.join(stagedArtifact, `CanAI-${version}-${options.platform === 'windows' ? 'windows-x64' : 'macos-arm64'}.zip`)
      await fs.copyFile(builtZip, packagePath)
      packageHash = await writeHashFile(packagePath)
      const unpackRoot = path.join(stage, 'unpacked')
      await fs.mkdir(unpackRoot, { recursive: true })
      const packageDirectory = await extractZip({ zip: packagePath, destination: unpackRoot, platform: options.platform, runner: hooks.runner, logPath: path.join(logs, 'unpack.log') })
      await runSmoke({ workspace: candidateRoot, packageDir: packageDirectory, platform: options.platform, nodePath, runner: hooks.runner, logs })
    }
    progress('publishing candidate and writing artifact pointer')
    if (git(candidateRoot, ['status', '--porcelain']).trim()) throw new Error('Public candidate became dirty during release packaging')
    await fs.cp(logs, path.join(stagedArtifact, 'logs'), { recursive: true })
    const provenance = {
      format: 'canai-public-release',
      edition: 'local',
      version,
      sourceRevision: fullRevision,
      sourceRevisionShort: revision,
      publicCommit: candidate.commit,
      platform: options.platform,
      sourceOnly: options.sourceOnly,
      node: execFileSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
      gitleaks: GITLEAKS_VERSION,
      sourceArchive: { file: path.basename(sourceZip), sha256: sourceHash },
      package: packagePath ? { file: path.basename(packagePath), sha256: packageHash } : null,
      exportedFiles: exporterResult.files?.length ?? null,
    }
    await fs.writeFile(path.join(stagedArtifact, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
    // Publish first, then atomically seal the immutable artifact directory, and
    // update the success pointer last. If either later step fails, a retry can
    // observe the already-published commit and reuse the sealed artifact; no
    // rollback or overwrite of an older snapshot is attempted.
    const publish = hooks.publishCandidate ?? publishCandidate
    const copy = hooks.copyArtifacts ?? copyArtifacts
    const writePointer = hooks.writeLatestPointer ?? writeLatestPointer
    const artifactMetadata = {
      version,
      sourceRevision: fullRevision,
      publicCommit: candidate.commit,
      platform: options.platform,
      sourceOnly: options.sourceOnly,
    }
    const existingArtifact = await lstatOrNull(artifactDirectory)
    if (existingArtifact) await assertReusableArtifact(artifactDirectory, artifactMetadata)
    const published = await publish({ candidateRoot, publicRoot, publicInfo, commit: candidate.commit })
    await copy({
      stage: stagedArtifact,
      destination: artifactDirectory,
      reuseExisting: true,
      expected: artifactMetadata,
    })
    const latest = await writePointer({ artifactRoot, artifactDirectory, version, revision: fullRevision, publicCommit: candidate.commit, platform: options.platform, pointerName })
    try { await removeProjectTemp(root, stage, 'canai-release-prepare-') } catch (error) { progress(`warning: retained release diagnostics after cleanup failure (${error.message})`) }
    return {
      version,
      revision: fullRevision,
      candidateCommit: candidate.commit,
      published,
      artifactDirectory,
      latest,
      sourceZip: path.join(artifactDirectory, path.basename(sourceZip)),
      packagePath: packagePath ? path.join(artifactDirectory, path.basename(packagePath)) : null,
    }
  } catch (error) {
    if (stage) error.releaseStage = stage
    if (candidateRoot) error.candidateRoot = candidateRoot
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), ROOT)
  if (options.help) {
    console.log(usage())
    return
  }
  const handoff = maybeReexecWithPinnedNode(options)
  if (handoff !== null) {
    process.exitCode = handoff
    return
  }
  console.log(`[release] authoring source: ${path.resolve(options.root)}`)
  console.log(`[release] canonical public checkout: ${path.resolve(options.publicRoot)}`)
  console.log(`[release] artifact root: ${path.resolve(options.artifactRoot)}`)
  try {
    const result = await preparePublicRelease(options)
    console.log(`[release] prepared ${result.version} from ${result.revision}`)
    console.log(`[release] public checkout: ${result.published.root}`)
    console.log(`[release] artifacts: ${result.artifactDirectory}`)
  } catch (error) {
    console.error(`[release] ${error instanceof Error ? error.message : String(error)}`)
    if (error?.releaseStage) console.error(`[release] retained diagnostics: ${error.releaseStage}`)
    if (error?.candidateRoot) console.error(`[release] retained candidate: ${error.candidateRoot}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main()
