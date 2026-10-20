import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installGitleaks, GITLEAKS_VERSION } from './install-gitleaks.mjs'

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
}

export function npmBinary(nodePath = process.execPath) {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const sibling = path.join(path.dirname(nodePath), name)
  return sibling
}

export function npmInvocation(nodePath = process.execPath) {
  const cli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return { file: nodePath, prefix: [cli] }
  return { file: npmBinary(nodePath), prefix: [] }
}

export function defaultCommandRunner({ file, args, cwd, env, logPath }) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env }
    // Windows PowerShell 5 cannot load PowerShell 7's Utility module. Let
    // each child PowerShell discover modules for its own edition instead of
    // inheriting the host shell's module search path through Node/npm.
    if (process.platform === 'win32') {
      for (const key of Object.keys(childEnv)) {
        if (key.toLowerCase() === 'psmodulepath') delete childEnv[key]
      }
    }
    const child = spawn(file, args, { cwd, env: childEnv, windowsHide: true })
    const chunks = []
    const stream = fs.open(logPath, 'w').then((handle) => handle.createWriteStream())
    const write = (chunk) => {
      const text = Buffer.from(chunk)
      chunks.push(text)
      void stream.then((target) => target.write(text))
    }
    child.stdout?.on('data', write)
    child.stderr?.on('data', write)
    child.once('error', reject)
    child.once('close', async (code, signal) => {
      try {
        const target = await stream
        await new Promise((done) => target.end(done))
      } catch (error) {
        reject(error)
        return
      }
      resolve({ code: code ?? 1, signal, output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

export async function runCommand({ runner = defaultCommandRunner, label, file, args = [], cwd, env, logPath }) {
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const result = await runner({ file, args, cwd, env, logPath, label })
  if ((result?.code ?? 1) !== 0) {
    throw new Error(`${label} failed with exit ${result?.code ?? 1}; see ${logPath}`)
  }
  return result
}

export async function resolveGitleaks({ explicit, workspace, verifyBinary = verifyGitleaksBinary, install = installGitleaks }) {
  const provided = explicit || process.env.GITLEAKS_BIN
  if (provided) {
    await verifyBinary(provided)
    return path.resolve(provided)
  }
  const output = path.join(workspace, 'tools')
  const binary = await install({ output })
  await verifyBinary(binary)
  return path.resolve(binary)
}

export async function verifyGitleaksBinary(binary) {
  const target = path.resolve(binary)
  const stat = await fs.lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Gitleaks path is not a regular file: ${target}`)
  let output = ''
  try {
    output = execFileSync(target, ['version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  } catch {
    try {
      output = execFileSync(target, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    } catch {
      throw new Error(`Unable to execute Gitleaks binary: ${target}`)
    }
  }
  if (!new RegExp(`\\b${GITLEAKS_VERSION.replaceAll('.', '\\.')}(?:\\b|$)`, 'u').test(output)) {
    throw new Error(`Gitleaks ${GITLEAKS_VERSION} is required: ${target}`)
  }
}

export async function runNpmGates({ workspace, nodePath = process.execPath, runner, logs }) {
  const npm = npmInvocation(nodePath)
  const env = { ...process.env, PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}` }
  const stages = [
    ['npm ci root', workspace, ['ci', '--prefix', workspace]],
    ['npm ci server', workspace, ['ci', '--prefix', path.join(workspace, 'server')]],
    ['npm ci client', workspace, ['ci', '--prefix', path.join(workspace, 'client')]],
    ['npm run check', workspace, ['run', 'check', '--prefix', workspace]],
    ['npm test', workspace, ['test', '--prefix', workspace]],
    ['npm audit root', workspace, ['audit', '--prefix', workspace, '--audit-level=high']],
    ['npm audit server', workspace, ['audit', '--prefix', path.join(workspace, 'server'), '--audit-level=high']],
    ['npm audit client', workspace, ['audit', '--prefix', path.join(workspace, 'client'), '--audit-level=high']],
  ]
  for (const [label, cwd, args] of stages) {
    await runCommand({ runner, label, file: npm.file, args: [...npm.prefix, ...args], cwd, env, logPath: path.join(logs, `${slug(label)}.log`) })
  }
}

export async function runNpmInstall({ workspace, nodePath = process.execPath, runner, logs, label = 'candidate npm ci' }) {
  const npm = npmInvocation(nodePath)
  const env = { ...process.env, PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}` }
  const roots = [workspace, path.join(workspace, 'server'), path.join(workspace, 'client')]
  for (const root of roots) {
    const suffix = path.basename(root) === path.basename(workspace) ? 'root' : path.basename(root)
    await runCommand({
      runner,
      label: `${label} ${suffix}`,
      file: npm.file,
      args: [...npm.prefix, 'ci', '--prefix', root],
      cwd: workspace,
      env,
      logPath: path.join(logs, `${slug(label)}-${suffix}.log`),
    })
  }
}

export async function runSecretScan({ workspace, gitleaks, nodePath = process.execPath, runner, logs, mode = 'dir' }) {
  const env = { ...process.env, PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}` }
  const scanner = path.join(workspace, 'scripts', 'scan-secrets.mjs')
  const args = [scanner, '--source', workspace, '--mode', mode, '--gitleaks', gitleaks, '--require-gitleaks']
  await runCommand({ runner, label: `secret scan ${mode}`, file: nodePath, args, cwd: workspace, env, logPath: path.join(logs, `scan-${mode}.log`) })
}

export async function runNativePackage({ workspace, platform, gitleaks, nodePath = process.execPath, runner, logs }) {
  const env = { ...process.env, GITLEAKS_BIN: gitleaks, PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}` }
  if (platform === 'windows') {
    await runCommand({
      runner,
      label: 'native Windows package',
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(workspace, 'make-dist.ps1')],
      cwd: workspace,
      env,
      logPath: path.join(logs, 'make-dist.log'),
    })
  } else if (platform === 'macos') {
    await runCommand({ runner, label: 'macOS FFmpeg runtime', file: 'zsh', args: [path.join(workspace, 'scripts/build-ffmpeg-macos.sh')], cwd: workspace, env, logPath: path.join(logs, 'build-ffmpeg-macos.log') })
    await runCommand({ runner, label: 'native macOS package', file: 'zsh', args: [path.join(workspace, 'make-dist.sh')], cwd: workspace, env, logPath: path.join(logs, 'make-dist.log') })
  } else {
    throw new Error(`Unsupported native release platform: ${platform}`)
  }
}

export async function extractZip({ zip, destination, platform, runner, logPath }) {
  if (platform === 'windows') {
    const env = { ...process.env, CANAI_RELEASE_ZIP: zip, CANAI_RELEASE_UNPACK: destination }
    await runCommand({ runner, label: 'unpack Windows package', file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:CANAI_RELEASE_ZIP -DestinationPath $env:CANAI_RELEASE_UNPACK'], cwd: destination, env, logPath })
  } else {
    await runCommand({ runner, label: 'unpack macOS package', file: 'unzip', args: ['-q', zip, '-d', destination], cwd: destination, env: process.env, logPath })
  }
  const children = (await fs.readdir(destination, { withFileTypes: true })).filter((entry) => entry.isDirectory())
  if (children.length !== 1) throw new Error(`Package unpack did not produce exactly one directory: ${destination}`)
  return path.join(destination, children[0].name)
}

export async function runSmoke({ workspace, packageDir, platform, nodePath = process.execPath, runner, logs }) {
  const env = { ...process.env, PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}` }
  await runCommand({
    runner,
    label: 'distribution smoke (two cycles)',
    file: nodePath,
    args: [path.join(workspace, 'scripts/smoke-distribution.mjs'), packageDir, '--platform', platform],
    cwd: workspace,
    env,
    logPath: path.join(logs, 'smoke-distribution.log'),
  })
}

export async function removeOwnedTemp(target, prefix) {
  const absolute = path.resolve(target)
  const tempRoot = path.resolve(os.tmpdir())
  const relative = path.relative(tempRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(absolute).startsWith(prefix)) {
    throw new Error(`Refusing to remove unexpected temporary path: ${target}`)
  }
  const stat = await fs.lstat(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to remove temporary path: ${target}`)
  const realRoot = await fs.realpath(tempRoot)
  const realTarget = await fs.realpath(absolute)
  const realRelative = path.relative(realRoot, realTarget)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`Refusing temporary path outside temp: ${target}`)
  await fs.rm(absolute, { recursive: true, force: true })
}

export function packageZip(workspace) {
  const directory = path.join(workspace, 'dist-package')
  return fs.readdir(directory).then((entries) => {
    const zips = entries.filter((name) => name.toLowerCase().endsWith('.zip') && !name.endsWith('.sha256'))
    if (zips.length !== 1) throw new Error(`Expected one native package ZIP in ${directory}`)
    return path.join(directory, zips[0])
  })
}
