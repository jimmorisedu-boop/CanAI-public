import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  PORTABLE_PYTHON_ARCHIVE_SHA256,
  PORTABLE_PYTHON_VERSION,
  PYTHON_RUNTIME_ARCHIVE_FILE,
  downloadPythonRuntimeArchive,
  hashPythonRuntimeTree,
  inspectPythonRuntime,
  installPythonRuntime,
  pythonLaunch,
  requiredPythonRuntimeFiles,
  resolvePythonRuntime,
  runtimeRoot,
  sha256,
  type PythonRuntimeMetadata,
} from './python-runtime.js'
import { AgentPackageError } from './package-errors.js'
import { removeOwnedRuntimeArchive, writeAuthoritativeRuntimeArchive } from './python-runtime-baseline.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; runtimeRoot: string; packageRoot: string; expected: PythonRuntimeMetadata }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-python-runtime-'))
  roots.push(root)
  const runtime = path.join(root, `python-${PORTABLE_PYTHON_VERSION}`)
  const packageRoot = path.join(root, 'package')
  await fs.mkdir(runtime, { recursive: true })
  await fs.mkdir(packageRoot, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(runtime, 'python.exe'), 'fake-executable'),
    fs.writeFile(path.join(runtime, 'python313.zip'), 'fake-stdlib'),
    fs.writeFile(path.join(runtime, 'python313.dll'), 'fake-dll'),
    fs.writeFile(path.join(runtime, 'python313._pth'), 'python313.zip\n.\n'),
    fs.writeFile(path.join(packageRoot, 'main.py'), 'print("Привет")'),
  ])
  const tree = await hashPythonRuntimeTree(runtime)
  const files = requiredPythonRuntimeFiles(tree.files)
  const expected: PythonRuntimeMetadata = {
    kind: 'python', version: PORTABLE_PYTHON_VERSION, integrity: tree.treeSha, treeSha: tree.treeSha,
    environmentId: sha256(`python\0${PORTABLE_PYTHON_VERSION}\0${tree.treeSha}`).slice(0, 32),
    executableRelative: files.executable, stdlibIntegrity: tree.byName.get(files.stdlib)!, archiveSha: PORTABLE_PYTHON_ARCHIVE_SHA256,
  }
  return { root, runtimeRoot: runtime, packageRoot, expected }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof AgentPackageError ? error.code : undefined
}

describe('portable Python runtime integrity', () => {
  it('counts tree entries without sparse-array holes and requires a receipt baseline', async () => {
    const input = await fixture()
    const tree = await hashPythonRuntimeTree(input.runtimeRoot)
    assert.deepEqual(tree.files, ['python.exe', 'python313._pth', 'python313.dll', 'python313.zip'])
    let probes = 0
    await assert.rejects(resolvePythonRuntime(input.runtimeRoot, undefined, { platform: 'win32', arch: 'x64', versionProbe: async () => { probes += 1; return PORTABLE_PYTHON_VERSION } }), (error: unknown) => errorCode(error) === 'RUNTIME_BASELINE_REQUIRED')
    assert.equal(probes, 0)
  })

  it('compares pins before version execution and rejects every static tamper', async () => {
    const names = ['python.exe', 'python313.zip', 'python313._pth', 'python313.dll']
    for (const name of names) {
      const input = await fixture()
      await fs.appendFile(path.join(input.runtimeRoot, name), 'tamper')
      let probes = 0
      await assert.rejects(resolvePythonRuntime(input.runtimeRoot, input.expected, {
        platform: 'win32', arch: 'x64', versionProbe: async () => { probes += 1; return PORTABLE_PYTHON_VERSION },
      }), (error: unknown) => errorCode(error) === 'RUNTIME_PIN_MISMATCH')
      assert.equal(probes, 0, `${name} must not execute before static pin comparison`)
    }
    const input = await fixture()
    const metadataTampered = { ...input.expected, environmentId: '0'.repeat(32) }
    let probes = 0
    await assert.rejects(resolvePythonRuntime(input.runtimeRoot, metadataTampered, {
      platform: 'win32', arch: 'x64', versionProbe: async () => { probes += 1; return PORTABLE_PYTHON_VERSION },
    }), (error: unknown) => errorCode(error) === 'RUNTIME_PIN_MISMATCH')
    assert.equal(probes, 0)
  })

  it('accepts the exact pinned version and forces isolated UTF-8 probing', async () => {
    const input = await fixture()
    let request: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined
    const runtime = await resolvePythonRuntime(input.runtimeRoot, input.expected, {
      platform: 'win32', arch: 'x64', versionProbe: async (value) => { request = value; return PORTABLE_PYTHON_VERSION },
    })
    assert.equal(runtime.version, PORTABLE_PYTHON_VERSION)
    assert.deepEqual(request?.args.slice(0, 7), ['-I', '-S', '-B', '-u', '-X', 'utf8', '-c'])
    assert.equal(request?.env.PYTHONPATH, undefined)
    assert.equal(request?.env.PYTHONHOME, undefined)
    const input2 = await fixture()
    await assert.rejects(resolvePythonRuntime(input2.runtimeRoot, input2.expected, {
      platform: 'win32', arch: 'x64', versionProbe: async () => '3.13.160',
    }), (error: unknown) => errorCode(error) === 'RUNTIME_VERSION_UNSUPPORTED')
  })

  it('refuses an unknown receipt, symlinked runtime, and unbounded launch paths', async () => {
    const input = await fixture()
    const status = await inspectPythonRuntime(input.root, 'win32', 'x64', { versionProbe: async () => PORTABLE_PYTHON_VERSION })
    assert.equal(status.ready, false)
    assert.match(status.reason ?? '', /RUNTIME_BASELINE_REQUIRED/u)
    await assert.rejects(Promise.resolve().then(() => pythonLaunch(input.expected, input.root, path.join(input.root, 'outside.py'), false, input.packageRoot)), (error: unknown) => errorCode(error) === 'RUNTIME_PATH_INVALID')
  })

  it('builds bounded script/module bootstrap only under immutable packageRoot', async () => {
    const input = await fixture()
    const script = pythonLaunch(input.expected, input.root, path.join(input.packageRoot, 'main.py'), false, input.packageRoot)
    assert.ok(script.args.includes('-X') && script.args.includes('utf8'))
    assert.ok(script.args.includes('-c'))
    assert.match(script.args.at(-1) ?? '', /runpy\.run_path/u)
    await fs.mkdir(path.join(input.packageRoot, 'worker'), { recursive: true })
    await fs.writeFile(path.join(input.packageRoot, 'worker', '__main__.py'), 'print("Привет")')
    const module = pythonLaunch(input.expected, input.root, 'worker', true, input.packageRoot)
    assert.match(module.args.at(-1) ?? '', /runpy\.run_module/u)
    await assert.rejects(Promise.resolve().then(() => pythonLaunch(input.expected, input.root, 'worker', true)), (error: unknown) => errorCode(error) === 'RUNTIME_PACKAGE_ROOT_REQUIRED')
  })

  it('does not trust a forged receipt without the verified distribution archive', async () => {
    const input = await fixture()
    const forgedArchive = Buffer.from('not the official CPython ZIP')
    await fs.writeFile(path.join(input.root, 'python-3.13.16-embed-amd64.zip'), forgedArchive)
    await fs.writeFile(path.join(input.root, 'python-runtime.receipt.json'), JSON.stringify({
      schemaVersion: 1,
      sourceUrl: 'https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip',
      archiveSha: PORTABLE_PYTHON_ARCHIVE_SHA256,
      runtime: input.expected,
    }))
    let probes = 0
    const status = await inspectPythonRuntime(input.root, 'win32', 'x64', { versionProbe: async () => { probes += 1; return PORTABLE_PYTHON_VERSION } })
    assert.equal(status.ready, false)
    assert.match(status.reason ?? '', /SHA-256/u)
    assert.equal(probes, 0)
  })

  it('uses a deterministic bounded transport and rejects wrong hash/redirects', async () => {
    const bytes = Buffer.from('fake zip bytes')
    const archiveSha = sha256(bytes)
    const calls: string[] = []
    const downloaded = await downloadPythonRuntimeArchive({
      fetchImpl: async (url) => { calls.push(String(url)); return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }) },
      archiveSha256: archiveSha,
    })
    assert.equal(downloaded.archiveSha, archiveSha)
    assert.equal(calls.length, 1)
    await assert.rejects(downloadPythonRuntimeArchive({
      fetchImpl: async () => new Response(bytes, { status: 200 }),
    }), (error: unknown) => errorCode(error) === 'RUNTIME_ARCHIVE_TAMPERED')
    await assert.rejects(downloadPythonRuntimeArchive({
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/runtime.zip' } }),
    }), (error: unknown) => errorCode(error) === 'RUNTIME_REDIRECT_UNSAFE')
    await assert.rejects(downloadPythonRuntimeArchive({
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])) } }), { status: 200 }),
    }), (error: unknown) => errorCode(error) === 'RUNTIME_DOWNLOAD_TIMEOUT')
  })

  it('uses exclusive-copy fallback when hard-links are unsupported and never deletes its unproven winner', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-python-archive-fallback-'))
    roots.push(root)
    const bytes = Buffer.from('verified archive placeholder')
    const unsupported = Object.assign(new Error('hard-links unsupported'), { code: 'ENOTSUP' })
    const commit = await writeAuthoritativeRuntimeArchive(root, bytes, { linkImpl: async () => { throw unsupported } })
    assert.equal(commit.hardLinkOwned, false)
    assert.deepEqual(await fs.readFile(path.join(root, PYTHON_RUNTIME_ARCHIVE_FILE)), bytes)
    await removeOwnedRuntimeArchive(commit)
    // Fallback ownership is intentionally unproven; rollback preserves the
    // destination rather than risking removal of a concurrent winner.
    assert.deepEqual(await fs.readFile(path.join(root, PYTHON_RUNTIME_ARCHIVE_FILE)), bytes)
    await fs.rm(path.join(root, PYTHON_RUNTIME_ARCHIVE_FILE), { force: true })
  })

  it('preserves an existing current tree and cleans failed installation staging', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-python-install-'))
    roots.push(root)
    const target = runtimeRoot(root)
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'keep.txt'), 'previous')
    let fetches = 0
    await assert.rejects(import('./python-runtime.js').then(({ installPythonRuntime }) => installPythonRuntime({
      runtimeDir: root,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => { fetches += 1; return new Response(Buffer.from('wrong archive'), { status: 200 }) },
    })), (error: unknown) => errorCode(error) === 'RUNTIME_TARGET_CONFLICT')
    assert.equal(fetches, 0)
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'previous')
    await fs.rm(target, { recursive: true, force: true })
    await assert.rejects(import('./python-runtime.js').then(({ installPythonRuntime }) => installPythonRuntime({
      runtimeDir: root,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => new Response(Buffer.from('wrong archive'), { status: 200 }),
    })), (error: unknown) => errorCode(error) === 'RUNTIME_ARCHIVE_TAMPERED')
    const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.stage-'))
    assert.deepEqual(leftovers, [])
  })

  it('recovers a receipt-window interruption from the official ZIP fixture only', async (testContext) => {
    const archivePath = process.env.CANAI_VERIFIED_PYTHON_ARCHIVE
    if (!archivePath) {
      testContext.skip('set CANAI_VERIFIED_PYTHON_ARCHIVE for the opt-in official ZIP regression')
      return
    }
    const bytes = await fs.readFile(archivePath)
    assert.equal(sha256(bytes), PORTABLE_PYTHON_ARCHIVE_SHA256)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-python-install-receipt-window-'))
    roots.push(root)
    let probes = 0
    const fetchImpl = async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
    await assert.rejects(installPythonRuntime({
      runtimeDir: root,
      platform: 'win32',
      arch: 'x64',
      fetchImpl,
      versionProbe: async () => {
        probes += 1
        await fs.writeFile(path.join(root, 'python-runtime.receipt.json'), '{interrupted')
        return PORTABLE_PYTHON_VERSION
      },
    }), (error: unknown) => errorCode(error) === 'RUNTIME_TARGET_CONFLICT')
    assert.equal(probes, 1)
    await fs.stat(path.join(root, PYTHON_RUNTIME_ARCHIVE_FILE))
    await fs.stat(runtimeRoot(root))

    const recovered = await installPythonRuntime({
      runtimeDir: root,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => { throw new Error('recovery must not download') },
      versionProbe: async () => { throw new Error('recovery must not execute') },
    })
    assert.equal(recovered.archiveSha, PORTABLE_PYTHON_ARCHIVE_SHA256)
    assert.equal(probes, 1)
    const receipt = JSON.parse(await fs.readFile(path.join(root, 'python-runtime.receipt.json'), 'utf8')) as { runtime: PythonRuntimeMetadata }
    assert.deepEqual(receipt.runtime, recovered)
  })

  it('shares one install flight across canonical aliases and keeps the archive winner', async (testContext) => {
    const archivePath = process.env.CANAI_VERIFIED_PYTHON_ARCHIVE
    if (!archivePath) {
      testContext.skip('set CANAI_VERIFIED_PYTHON_ARCHIVE for the opt-in concurrency regression')
      return
    }
    const bytes = await fs.readFile(archivePath)
    assert.equal(sha256(bytes), PORTABLE_PYTHON_ARCHIVE_SHA256)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-python-install-alias-'))
    roots.push(root)
    let fetches = 0
    let probes = 0
    const fetchImpl = async () => {
      fetches += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
    }
    const [left, right] = await Promise.all([
      installPythonRuntime({ runtimeDir: root, platform: 'win32', arch: 'x64', fetchImpl, versionProbe: async () => { probes += 1; return PORTABLE_PYTHON_VERSION } }),
      installPythonRuntime({ runtimeDir: path.join(root, 'nested', '..'), platform: 'win32', arch: 'x64', fetchImpl, versionProbe: async () => { probes += 1; return PORTABLE_PYTHON_VERSION } }),
    ])
    assert.equal(fetches, 1)
    assert.equal(probes, 1)
    assert.deepEqual(left, right)
    await fs.stat(path.join(root, PYTHON_RUNTIME_ARCHIVE_FILE))
    await fs.stat(path.join(root, 'python-runtime.receipt.json'))
  })

  it('rejects a symlinked runtime ancestor before transport and preserves a genuine winner', async (testContext) => {
    const archivePath = process.env.CANAI_VERIFIED_PYTHON_ARCHIVE
    if (!archivePath) {
      testContext.skip('set CANAI_VERIFIED_PYTHON_ARCHIVE for the opt-in symlink concurrency regression')
      return
    }
    const bytes = await fs.readFile(archivePath)
    assert.equal(sha256(bytes), PORTABLE_PYTHON_ARCHIVE_SHA256)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-python-install-symlink-'))
    roots.push(root)
    const genuine = path.join(root, 'runtime')
    const alias = path.join(root, 'alias')
    try { await fs.symlink(root, alias, 'junction') }
    catch (error) {
      testContext.skip(`symlink unavailable: ${String(error)}`)
      return
    }
    let fetches = 0
    const fetchImpl = async () => { fetches += 1; return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }) }
    const results = await Promise.allSettled([
      installPythonRuntime({ runtimeDir: genuine, platform: 'win32', arch: 'x64', fetchImpl, versionProbe: async () => PORTABLE_PYTHON_VERSION }),
      installPythonRuntime({ runtimeDir: path.join(alias, 'runtime'), platform: 'win32', arch: 'x64', fetchImpl, versionProbe: async () => PORTABLE_PYTHON_VERSION }),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected' && errorCode(rejected.reason) === 'RUNTIME_PATH_INVALID')
    assert.equal(fetches, 1)
    await fs.stat(path.join(genuine, PYTHON_RUNTIME_ARCHIVE_FILE))
  })
})
