import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import http, { type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const batchPath = path.join(repoRoot, 'Start CanAI.bat')
const stopBatchPath = path.join(repoRoot, 'Stop CanAI.bat')
const scriptPath = path.join(repoRoot, 'start.ps1')
const stopScriptPath = path.join(repoRoot, 'stop.ps1')
const activationScriptPath = path.join(repoRoot, 'activate-share.ps1')
const distScriptPath = path.join(repoRoot, 'make-dist.ps1')
const buyerReadmePath = path.join(repoRoot, 'USER-GUIDE.md')

const powershellCommand = (process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'])
  .find((command) => spawnSync(command, ['-NoProfile', '-Command', 'exit 0']).status === 0)
const powershellTest = powershellCommand ? test : test.skip

function requirePowerShell(): string {
  if (!powershellCommand) throw new Error('PowerShell недоступен в этой системе')
  return powershellCommand
}

interface FakeCanAi {
  port: number
  instanceId: string
  shutdownToken: string
  statusRequests: number
  shutdownRequests: number
  shareStartRequests: number
  receivedTokens: string[]
  server: Server
}

interface LauncherOptions {
  inheritedMockMode?: boolean
  simulateBindRace?: boolean
  synchronizeDependencies?: boolean
  failInstallWhilePortListening?: boolean
  remotePort?: number
}

function markDependenciesAsSynchronized(root: string): void {
  for (const relativeDir of ['.', 'server', 'client']) {
    const directory = path.join(root, relativeDir)
    const lock = fsSync.readFileSync(path.join(directory, 'package-lock.json'))
    const hash = createHash('sha256').update(lock).digest('hex')
    fsSync.writeFileSync(path.join(directory, 'node_modules', '.canai-lock.sha256'), hash, 'ascii')
  }
}

function serverFingerprint(root: string): string {
  const serverRoot = path.join(root, 'server')
  const files = [
    path.join(serverRoot, 'src', 'index.ts'),
    path.join(serverRoot, 'package.json'),
    path.join(serverRoot, 'package-lock.json'),
  ].sort()
  const entries = files.map((file) => {
    const relative = path.relative(serverRoot, file).replaceAll('\\', '/')
    const hash = createHash('sha256').update(fsSync.readFileSync(file)).digest('hex')
    return `${relative}=${hash}`
  })
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-launcher-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

async function makePortableLauncherRoot(t: TestContext): Promise<string> {
  const root = await makeTempDir(t)
  await fs.copyFile(scriptPath, path.join(root, 'start.ps1'))
  for (const relativeDir of ['.', 'server', 'client']) {
    const directory = path.join(root, relativeDir)
    await fs.mkdir(path.join(directory, 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(directory, 'package-lock.json'), '{}')
  }
  await fs.mkdir(path.join(root, 'client', 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'server', 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'server', 'src', 'index.ts'), 'portable server')
  await fs.writeFile(path.join(root, 'server', 'package.json'), '{}')
  await fs.mkdir(path.join(root, 'client', 'public'), { recursive: true })
  await fs.mkdir(path.join(root, 'client', 'dist'), { recursive: true })
  await fs.writeFile(path.join(root, 'client', 'package.json'), '{}')
  await fs.writeFile(path.join(root, 'client', 'vite.config.ts'), '')
  await fs.writeFile(path.join(root, 'client', 'vite.guest.config.ts'), '')
  await fs.writeFile(path.join(root, 'client', 'vite.tablet.config.ts'), '')
  await fs.writeFile(path.join(root, 'client', 'dist', 'index.html'), '')
  await fs.mkdir(path.join(root, 'client', 'dist', 'guest'), { recursive: true })
  await fs.writeFile(path.join(root, 'client', 'dist', 'guest', 'guest.html'), '')
  await fs.mkdir(path.join(root, 'client', 'dist', 'tablet'), { recursive: true })
  await fs.writeFile(path.join(root, 'client', 'dist', 'tablet', 'tablet.html'), '')
  return root
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function reserveConsecutivePorts(t: TestContext, count = 4): Promise<{ start: number; servers: Server[] }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const servers: Server[] = []
    try {
      const first = http.createServer()
      await new Promise<void>((resolve, reject) => {
        first.once('error', reject)
        // Keep exact-port fixtures away from the automatic ephemeral pool:
        // launcher HTTP probes also allocate local client ports after we release it.
        first.listen(randomInt(20_000, 30_000), '127.0.0.1', resolve)
      })
      servers.push(first)
      const address = first.address()
      if (!address || typeof address === 'string' || address.port + count - 1 > 65535) throw new Error('неподходящий диапазон')
      for (let offset = 1; offset < count; offset++) {
        const server = http.createServer()
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(address.port + offset, '127.0.0.1', resolve)
        })
        servers.push(server)
      }
      t.after(async () => {
        await Promise.all(servers.map((server) => closeServer(server).catch(() => {})))
      })
      return { start: address.port, servers }
    } catch {
      await Promise.all(servers.map((server) => closeServer(server).catch(() => {})))
    }
  }
  throw new Error('не удалось зарезервировать последовательные тестовые порты')
}

async function startFakeCanAi(
  t: TestContext,
  options: { mockMode?: boolean; foreign?: boolean; serverFingerprint?: string; port?: number } = {},
): Promise<FakeCanAi> {
  const state: FakeCanAi = {
    port: 0,
    instanceId: randomUUID(),
    shutdownToken: randomUUID(),
    statusRequests: 0,
    shutdownRequests: 0,
    shareStartRequests: 0,
    receivedTokens: [],
    server: http.createServer(),
  }
  state.server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      state.statusRequests += 1
      if (options.foreign) {
        res.statusCode = 404
        res.end('not CanAI')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        falConfigured: !options.mockMode,
        mockMode: Boolean(options.mockMode),
        instanceId: state.instanceId,
        shuttingDown: false,
        serverFingerprint: options.serverFingerprint,
      }))
      return
    }
    if (req.url === '/api/lifecycle/shutdown' && req.method === 'POST') {
      state.shutdownRequests += 1
      const token = String(req.headers['x-canai-shutdown-token'] ?? '')
      state.receivedTokens.push(token)
      if (token !== state.shutdownToken) {
        res.statusCode = 403
        res.end('forbidden')
        return
      }
      res.statusCode = 202
      res.setHeader('content-type', 'application/json')
      res.end('{"shuttingDown":true}', () => state.server.close())
      return
    }
    if (req.url === '/api/shares/transport/start' && req.method === 'POST') {
      state.shareStartRequests += 1
      res.setHeader('content-type', 'application/json')
      res.end('{"origin":"https://panfilov.space/canai/o/test"}')
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    state.server.once('error', reject)
    state.server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  const address = state.server.address()
  if (!address || typeof address === 'string') throw new Error('не удалось открыть fake-порт')
  state.port = address.port
  t.after(async () => {
    if (!state.server.listening) return
    await new Promise<void>((resolve) => state.server.close(() => resolve()))
  })
  return state
}

async function runLauncher(
  port: number,
  dataDir?: string,
  launcherRoot = repoRoot,
  options: LauncherOptions = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  if (options.synchronizeDependencies !== false) markDependenciesAsSynchronized(launcherRoot)
  const launcherPath = path.join(launcherRoot, 'start.ps1')
  const escapedScriptPath = launcherPath.replaceAll("'", "''")
  const npmStub = options.failInstallWhilePortListening
    ? "function global:npm { if ($args.Count -gt 0 -and [string]$args[0] -eq 'ci') { $client = New-Object Net.Sockets.TcpClient; $listening = $false; try { $client.Connect('127.0.0.1', [int]$env:PORT); $listening = $client.Connected } catch {} finally { $client.Dispose() }; if ($listening) { Write-Output '[test] npm blocked-by-running-server'; $global:LASTEXITCODE = 1; return }; Write-Output '[test] npm install-after-shutdown' }; Write-Output ('[test] npm PORT=' + [string]$env:PORT); Write-Output ('[test] npm REMOTE_PORT=' + [string]$env:CANAI_REMOTE_PORT); $global:LASTEXITCODE = 0 }"
    : options.simulateBindRace
      ? "function global:npm { $global:npmCalls = 1 + [int]$global:npmCalls; if ($global:npmCalls -eq 1) { $global:bindRaceListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$env:PORT); $global:bindRaceListener.Start(); $global:LASTEXITCODE = 1; return }; Write-Output ('[test] npm PORT=' + [string]$env:PORT); Write-Output ('[test] npm REMOTE_PORT=' + [string]$env:CANAI_REMOTE_PORT); $global:LASTEXITCODE = 0 }"
    : "function global:npm { Write-Output ('[test] npm data=' + [string]$env:CANAI_DATA_DIR); Write-Output ('[test] npm mock=' + [string]$env:CANAI_MOCK); Write-Output ('[test] npm PORT=' + [string]$env:PORT); Write-Output ('[test] npm REMOTE_PORT=' + [string]$env:CANAI_REMOTE_PORT); $global:LASTEXITCODE = 0 }"
  const command = [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'function global:Start-Process { param([Parameter(ValueFromRemainingArguments=$true)] [object[]] $Ignored) }',
    'function global:Start-Job { param([Parameter(ValueFromRemainingArguments=$true)] [object[]] $Ignored) }',
    npmStub,
    `& '${escapedScriptPath}'`,
    'exit $LASTEXITCODE',
  ].join('; ')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
  }
  delete env.CANAI_REMOTE_PORT
  if (options.remotePort !== undefined) env.CANAI_REMOTE_PORT = String(options.remotePort)
  if (options.inheritedMockMode) env.CANAI_MOCK = '1'
  else delete env.CANAI_MOCK
  if (dataDir) {
    env.CANAI_DATA_DIR = dataDir
    env.CANAI_ENV_FILE = path.join(dataDir, 'missing.env')
  } else {
    delete env.CANAI_DATA_DIR
    delete env.CANAI_ENV_FILE
  }
  const child = spawn(
    requirePowerShell(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      cwd: launcherRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const status = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`launcher не завершился вовремя\n${stdout}\n${stderr}`))
    }, 20_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
  return { status, stdout, stderr }
}

async function runIsolatedLauncher(
  t: TestContext,
  port: number,
  dataDir?: string,
  inheritedMockMode = false,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const launcherRoot = await makePortableLauncherRoot(t)
  return runLauncher(port, dataDir, launcherRoot, { inheritedMockMode })
}

async function runStopper(
  port: number | undefined,
  dataDir: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const escapedScriptPath = stopScriptPath.replaceAll("'", "''")
  const command = [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `& '${escapedScriptPath}'`,
    'exit $LASTEXITCODE',
  ].join('; ')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CANAI_DATA_DIR: dataDir,
  }
  if (port === undefined) delete env.PORT
  else env.PORT = String(port)
  const child = spawn(
    requirePowerShell(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const status = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`stopper не завершился вовремя\n${stdout}\n${stderr}`))
    }, 20_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
  return { status, stdout, stderr }
}

test('batch всегда оставляет окно открытым после PowerShell', () => {
  const source = fsSync.readFileSync(batchPath, 'utf8').replaceAll('\r', '')
  assert.match(source, /^pause\s*$/mi)
  assert.doesNotMatch(source, /^if not .* pause\s*$/mi)
})

test('pause стоит между сохранением и восстановлением exit code', () => {
  const source = fsSync.readFileSync(batchPath, 'utf8').replaceAll('\r', '')
  const pauses = source.match(/^pause\s*$/gmi) ?? []
  const saveExit = source.indexOf('set "CANAI_EXIT=%ERRORLEVEL%"')
  const pause = source.indexOf('\npause\n')
  const restoreExit = source.indexOf('exit /b %CANAI_EXIT%')
  assert.equal(pauses.length, 1)
  assert.ok(saveExit >= 0)
  assert.ok(pause > saveExit)
  assert.ok(restoreExit > pause)
  assert.doesNotMatch(source, /if not .* pause/i)
})

test('launcher считает SHA-256 без зависимости от автозагрузки PowerShell-модулей', () => {
  const source = fsSync.readFileSync(scriptPath, 'utf8')
  assert.doesNotMatch(source, /Get-FileHash/)
  assert.match(source, /Security\.Cryptography\.SHA256/)
})

test('остановщик сохраняет код PowerShell и всегда оставляет окно открытым', () => {
  const source = fsSync.readFileSync(stopBatchPath, 'utf8').replaceAll('\r', '')
  const call = source.indexOf('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"')
  const saveExit = source.indexOf('set "CANAI_EXIT=%ERRORLEVEL%"')
  const pause = source.indexOf('\npause\n')
  const restoreExit = source.indexOf('exit /b %CANAI_EXIT%')

  assert.ok(call >= 0)
  assert.ok(saveExit > call)
  assert.ok(pause > saveExit)
  assert.ok(restoreExit > pause)
  assert.equal(source.match(/^pause\s*$/gmi)?.length, 1)
})

test('Windows BAT сохраняются с CRLF и не ломают команду PowerShell', () => {
  for (const file of [batchPath, stopBatchPath]) {
    const source = fsSync.readFileSync(file, 'utf8')
    assert.match(source, /\r\n/, `${path.basename(file)} не содержит CRLF`)
    assert.doesNotMatch(source, /(?<!\r)\n/, `${path.basename(file)} содержит одиночный LF`)
  }
})

powershellTest('остановщик считает уже выключенный CanAI успехом', async (t) => {
  const dataDir = await makeTempDir(t)

  // TCP port 0 нельзя использовать как удалённый listener, поэтому параллельный
  // smoke-тест не успеет занять «только что освобождённый» порт между проверками.
  const result = await runStopper(0, dataDir)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CanAI is already stopped/i)
})

powershellTest('остановщик штатно завершает подтверждённый CanAI', async (t) => {
  const dataDir = await makeTempDir(t)
  const fake = await startFakeCanAi(t)
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: fake.instanceId,
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runStopper(fake.port, dataDir)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fake.shutdownRequests, 1)
  assert.deepEqual(fake.receivedTokens, [fake.shutdownToken])
  assert.equal(fake.server.listening, false)
  assert.match(result.stdout, /CanAI stopped/i)
})

powershellTest('остановщик не трогает CanAI с несовпадающим control-файлом', async (t) => {
  const dataDir = await makeTempDir(t)
  const fake = await startFakeCanAi(t)
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: randomUUID(),
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runStopper(fake.port, dataDir)

  assert.equal(result.status, 1)
  assert.equal(fake.shutdownRequests, 0)
  assert.equal(fake.server.listening, true)
  assert.match(result.stdout, /Nothing was stopped/i)
})

powershellTest('остановщик не трогает чужой listener', async (t) => {
  const dataDir = await makeTempDir(t)
  const fake = await startFakeCanAi(t, { foreign: true })

  const result = await runStopper(fake.port, dataDir)

  assert.equal(result.status, 1)
  assert.equal(fake.shutdownRequests, 0)
  assert.equal(fake.server.listening, true)
  assert.match(result.stdout, /used by another program/i)
})

test('дистрибутив включает запуск и остановку CanAI', () => {
  const dist = fsSync.readFileSync(distScriptPath, 'utf8')
  const readme = fsSync.readFileSync(buyerReadmePath, 'utf8')

  for (const required of [
    'Start CanAI.bat',
    'Stop CanAI.bat',
    'start.ps1',
    'stop.ps1',
  ]) {
    assert.ok(dist.includes(`'${required}'`), `${required} отсутствует в include`)
  }
  assert.doesNotMatch(dist, /Get-ChildItem[^\r\n]+-Filter '\*\.bat'/)
  assert.match(readme, /Stop CanAI\.bat/)
})


powershellTest('production CanAI переиспользуется без shutdown', async (t) => {
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)
  const expectedFingerprint = serverFingerprint(launcherRoot)
  const fake = await startFakeCanAi(t, { serverFingerprint: expectedFingerprint })

  const result = await runLauncher(fake.port, dataDir, launcherRoot)

  assert.equal(result.status, 0, result.stderr)
  assert.ok(fake.statusRequests >= 1)
  assert.equal(fake.shutdownRequests, 0)
  assert.match(result.stdout, /CanAI is already running/)
  assert.match(result.stdout, /opening it in the browser/i)
  assert.match(result.stdout, /This window will stay open/i)
  assert.doesNotMatch(result.stdout, /window will close/i)
})

/**
 * ⚠️ Корневые и клиентские пакеты нужны ТОЛЬКО сборке интерфейса. В поставке он
 * уже собран, а ставились они всегда: на чистой Windows 28.09.2026 покупатель
 * качал 260 МБ клиентских пакетов ни за что (серверных — 75 МБ).
 */
powershellTest('без сборки интерфейса клиентские пакеты не ставятся', async (t) => {
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)
  markDependenciesAsSynchronized(launcherRoot)
  for (const relativeDir of ['.', 'client']) {
    await fs.rm(path.join(launcherRoot, relativeDir, 'node_modules', '.canai-lock.sha256'))
  }
  const fake = await startFakeCanAi(t, { serverFingerprint: serverFingerprint(launcherRoot) })

  const result = await runLauncher(fake.port, dataDir, launcherRoot, { synchronizeDependencies: false })

  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /Синхронизирую зависимости в 'client'/u)
  assert.doesNotMatch(result.stdout, /Синхронизирую зависимости в '\.'/u)
  assert.doesNotMatch(result.stdout, /Собираю интерфейс/u)
})

powershellTest('сборка интерфейса сначала ставит его пакеты', async (t) => {
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)
  markDependenciesAsSynchronized(launcherRoot)
  await fs.rm(path.join(launcherRoot, 'client', 'node_modules', '.canai-lock.sha256'))
  const source = path.join(launcherRoot, 'client', 'src', 'main.tsx')
  await fs.writeFile(source, '')
  const later = new Date(Date.now() + 60_000)
  await fs.utimes(source, later, later)
  const fake = await startFakeCanAi(t, { serverFingerprint: serverFingerprint(launcherRoot) })

  const result = await runLauncher(fake.port, dataDir, launcherRoot, { synchronizeDependencies: false })

  assert.equal(result.status, 0, result.stdout + result.stderr)
  const sync = result.stdout.indexOf("Syncing dependencies in 'client'")
  const build = result.stdout.indexOf('Building the UI')
  assert.ok(sync >= 0, 'клиентские пакеты ставятся')
  assert.ok(build > sync, 'и до сборки, а не после')
})

/**
 * ⚠️ У архива, скачанного из интернета, Проводник ставит КАЖДОМУ распакованному
 * файлу время распаковки: 943 исходника из 943 оказались «новее» собранного
 * интерфейса (замер 28.09.2026), и по датам лаунчер пересобирал интерфейс у
 * каждого покупателя. Поставку узнаём по build-info.json без .git.
 */
powershellTest('поставка покупателя не пересобирает интерфейс из-за дат распаковки', async (t) => {
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)
  await fs.writeFile(path.join(launcherRoot, 'build-info.json'), '{"commit":"0123456789ab","date":null}')
  markDependenciesAsSynchronized(launcherRoot)
  await fs.rm(path.join(launcherRoot, 'client', 'node_modules', '.canai-lock.sha256'))
  const source = path.join(launcherRoot, 'client', 'src', 'main.tsx')
  await fs.writeFile(source, '')
  const later = new Date(Date.now() + 60_000)
  await fs.utimes(source, later, later)
  const fake = await startFakeCanAi(t, { serverFingerprint: serverFingerprint(launcherRoot) })

  const shipped = await runLauncher(fake.port, dataDir, launcherRoot, { synchronizeDependencies: false })
  assert.equal(shipped.status, 0, shipped.stdout + shipped.stderr)
  assert.doesNotMatch(shipped.stdout, /Building the UI/u, 'поставке пересобирать нечего')
  assert.doesNotMatch(shipped.stdout, /Syncing dependencies in 'client'/u)

  // Та же папка под git — копия разработчика: её исходники правда меняются.
  await fs.mkdir(path.join(launcherRoot, '.git'))
  const developer = await runLauncher(fake.port, dataDir, launcherRoot, { synchronizeDependencies: false })
  assert.equal(developer.status, 0, developer.stdout + developer.stderr)
  assert.match(developer.stdout, /Building the UI/u, 'копия под git по-прежнему решает по датам')
})

/**
 * ⚠️ packages/ — общие исходники: клиент собирает их в страницы (разбор ответа
 * помощника, каталог моделей), сервер читает те же файлы на лету. В списке, по
 * которому лаунчер решает «пересобрать интерфейс», папки не было: правка,
 * сделанная только там, после «Update CanAI.bat» доезжала до сервера и не доезжала
 * до собранной планшетной страницы (проверка 03.10.2026). Маковский лаунчер —
 * в launcherMacos.test.ts; правишь один — правь оба.
 */
powershellTest('правка только в packages/ пересобирает интерфейс', async (t) => {
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)
  markDependenciesAsSynchronized(launcherRoot)
  const fake = await startFakeCanAi(t, { serverFingerprint: serverFingerprint(launcherRoot) })
  const launch = async () => {
    const result = await runLauncher(fake.port, dataDir, launcherRoot, { synchronizeDependencies: false })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }

  // Папки packages в дереве ещё нет: это не ошибка и не повод собирать.
  assert.doesNotMatch(await launch(), /Building the UI/u)

  const shared = path.join(launcherRoot, 'packages', 'prompt-chat', 'response.ts')
  await fs.mkdir(path.dirname(shared), { recursive: true })
  await fs.writeFile(shared, '')
  const earlier = new Date(Date.now() - 60_000)
  await fs.utimes(shared, earlier, earlier)
  assert.doesNotMatch(await launch(), /Building the UI/u, 'общие исходники старше сборки — собирать нечего')

  const later = new Date(Date.now() + 60_000)
  await fs.utimes(shared, later, later)
  assert.match(await launch(), /Building the UI/u, 'новее сборки только файл в packages/')
})

test('лаунчер без полосы прогресса и снимает пометку только со своих файлов запуска', () => {
  const windows = fsSync.readFileSync(scriptPath, 'utf8')
  // Полоса прогресса PowerShell 5.1: архив Node.js 98 с с ней и 6 с без неё.
  assert.match(windows, /^\$ProgressPreference = 'SilentlyContinue'/mu)
  assert.ok(
    windows.indexOf("$ProgressPreference = 'SilentlyContinue'") < windows.indexOf('function Install-BundledNode'),
    'до первого скачивания',
  )
  // Пометку «скачано из интернета» снимаем с корня папки CanAI, не глубже.
  const unblock = windows.slice(windows.indexOf('Unblock-File') - 200, windows.indexOf('Unblock-File'))
  assert.match(unblock, /Join-Path \$root '\*'/u)
  assert.doesNotMatch(unblock, /-Recurse/u)
})

powershellTest('устаревший CanAI завершается до npm ci с обновлёнными зависимостями', async (t) => {
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)
  markDependenciesAsSynchronized(launcherRoot)
  await fs.writeFile(
    path.join(launcherRoot, 'server', 'package-lock.json'),
    '{"lockfileVersion":3,"updated":true}',
  )
  const fake = await startFakeCanAi(t, { serverFingerprint: 'old-server' })
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: fake.instanceId,
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runLauncher(fake.port, dataDir, launcherRoot, {
    synchronizeDependencies: false,
    failInstallWhilePortListening: true,
  })

  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(fake.shutdownRequests, 1)
  assert.equal(fake.server.listening, false)
  assert.match(result.stdout, /npm install-after-shutdown/i)
  assert.doesNotMatch(result.stdout, /npm blocked-by-running-server/i)
})

powershellTest('устаревший production CanAI безопасно перезапускается', async (t) => {
  const dataDir = await makeTempDir(t)
  const fake = await startFakeCanAi(t, { serverFingerprint: 'old-server' })
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: fake.instanceId,
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runIsolatedLauncher(t, fake.port, dataDir)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fake.shutdownRequests, 1)
  assert.equal(fake.server.listening, false)
  assert.match(result.stdout, /Old server stopped\. Starting the updated CanAI/i)
})

powershellTest('mock CanAI с совпадающим control-файлом завершается перед production-запуском', async (t) => {
  const dataDir = await makeTempDir(t)
  const fake = await startFakeCanAi(t, { mockMode: true })
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: fake.instanceId,
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runIsolatedLauncher(t, fake.port, dataDir)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fake.shutdownRequests, 1)
  assert.deepEqual(fake.receivedTokens, [fake.shutdownToken])
  assert.equal(fake.server.listening, false)
  assert.match(result.stdout, /Demo server stopped\. Starting regular CanAI/i)
  assert.match(result.stdout, /Starting regular CanAI/i)
})

powershellTest('default data-dir не превращается в явный CANAI_DATA_DIR', async (t) => {
  const fake = await startFakeCanAi(t, { mockMode: true })
  const launcherRoot = await makePortableLauncherRoot(t)
  const defaultDataDir = path.join(launcherRoot, 'server', 'data')
  const controlPath = path.join(defaultDataDir, 'runtime-control.json')
  await fs.mkdir(defaultDataDir, { recursive: true })
  await fs.writeFile(controlPath, JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: fake.instanceId,
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runLauncher(fake.port, undefined, launcherRoot)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[test\] npm data=\r?\n/)
  assert.doesNotMatch(result.stdout, /\[test\] npm data=.+server[\\/]data/i)
})

powershellTest('production-запуск очищает унаследованный CANAI_MOCK', async (t) => {
  const dataDir = await makeTempDir(t)
  const fake = await startFakeCanAi(t, { mockMode: true })
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: fake.instanceId,
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runIsolatedLauncher(t, fake.port, dataDir, true)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fake.server.listening, false)
  assert.match(result.stdout, /\[test\] npm mock=\r?\n/)
  assert.doesNotMatch(result.stdout, /\[test\] npm mock=1/)
})

powershellTest('несовпадающий control-файл не завершает mock CanAI', async (t) => {
  const dataDir = await makeTempDir(t)
  const fake = await startFakeCanAi(t, { mockMode: true })
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: randomUUID(),
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runIsolatedLauncher(t, fake.port, dataDir)

  assert.equal(result.status, 1)
  assert.equal(fake.shutdownRequests, 0)
  assert.equal(fake.server.listening, true)
  assert.match(result.stdout, /Could not verify that the demo server belongs/i)
})

powershellTest('чужой listener остаётся нетронутым', async (t) => {
  const dataDir = await makeTempDir(t)
  const fake = await startFakeCanAi(t, { foreign: true })

  const result = await runIsolatedLauncher(t, fake.port, dataDir)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fake.shutdownRequests, 0)
  assert.equal(fake.server.listening, true)
  assert.match(result.stdout, /used by another program; looking for a free address/is)
})

powershellTest('чужой основной порт выбирает следующий свободный', async (t) => {
  const range = await reserveConsecutivePorts(t)
  await Promise.all(range.servers.slice(1).map(closeServer))
  const dataDir = await makeTempDir(t)

  const result = await runIsolatedLauncher(t, range.start, dataDir)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(range.servers[0].listening, true)
  assert.match(result.stdout, new RegExp(`\\[test\\] npm PORT=${range.start + 1}`))
  assert.match(result.stdout, new RegExp(`\\[test\\] npm REMOTE_PORT=${range.start + 3}`))
})

powershellTest('занятый порт планшета выбирает следующую пару', async (t) => {
  const range = await reserveConsecutivePorts(t, 4)
  await closeServer(range.servers[0])
  await closeServer(range.servers[1])
  const dataDir = await makeTempDir(t)

  const result = await runIsolatedLauncher(t, range.start, dataDir)

  assert.equal(result.status, 0, result.stderr)
  // Пара range.start/range.start+2 конфликтует на планшетном порту. Пара
  // range.start+1/range.start+3 занята тоже, чтобы проверять переход через
  // несколько кандидатов, а не фиксировать случайный первый свободный порт.
  assert.equal(range.servers[2].listening, true)
  assert.equal(range.servers[3].listening, true)
  const selectedPort = Number(/\[test\] npm PORT=(\d+)/.exec(result.stdout)?.[1])
  const selectedRemotePort = Number(/\[test\] npm REMOTE_PORT=(\d+)/.exec(result.stdout)?.[1])
  assert.ok(Number.isInteger(selectedPort))
  assert.ok(selectedPort >= range.start + 4)
  assert.ok(selectedPort <= 65533)
  assert.ok(Number.isInteger(selectedRemotePort))
  assert.equal(selectedRemotePort, selectedPort + 2)
})

powershellTest('занятый только соседний порт не сдвигает основной порт', async (t) => {
  const range = await reserveConsecutivePorts(t)
  await closeServer(range.servers[0])
  await Promise.all(range.servers.slice(2).map(closeServer))
  const dataDir = await makeTempDir(t)

  const result = await runIsolatedLauncher(t, range.start, dataDir)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(range.servers[1].listening, true)
  assert.match(result.stdout, new RegExp(`\\[test\\] npm PORT=${range.start}`))
  assert.match(result.stdout, new RegExp(`\\[test\\] npm REMOTE_PORT=${range.start + 2}`))
})

powershellTest('быстрый конфликт bind пересчитывает порт', async (t) => {
  const range = await reserveConsecutivePorts(t)
  await Promise.all(range.servers.map(closeServer))
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)

  const result = await runLauncher(range.start, dataDir, launcherRoot, { simulateBindRace: true })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`\\[test\\] npm PORT=${range.start + 1}`))
  assert.match(result.stdout, new RegExp(`\\[test\\] npm REMOTE_PORT=${range.start + 3}`))
  assert.match(result.stdout, /choosing another free address/i)
})

powershellTest('явный CANAI_REMOTE_PORT сохраняется при выборе основного порта', async (t) => {
  const range = await reserveConsecutivePorts(t)
  await Promise.all(range.servers.map(closeServer))
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)

  const result = await runLauncher(range.start, dataDir, launcherRoot, { remotePort: range.start + 3 })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`\\[test\\] npm PORT=${range.start}`))
  assert.match(result.stdout, new RegExp(`\\[test\\] npm REMOTE_PORT=${range.start + 3}`))
})

powershellTest('порт планшета без явной настройки не выходит за 65535', async (t) => {
  const dataDir = await makeTempDir(t)
  const result = await runIsolatedLauncher(t, 65534, dataDir)

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /No free CanAI ports were found/i)
  assert.doesNotMatch(result.stdout, /npm REMOTE_PORT/)
})

powershellTest('повторный launcher находит свой CanAI на запасном порту из control-файла', async (t) => {
  const range = await reserveConsecutivePorts(t)
  await Promise.all(range.servers.slice(1).map(closeServer))
  const dataDir = await makeTempDir(t)
  const launcherRoot = await makePortableLauncherRoot(t)
  const fake = await startFakeCanAi(t, {
    port: range.start + 1,
    serverFingerprint: serverFingerprint(launcherRoot),
  })
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: fake.instanceId,
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runLauncher(range.start, dataDir, launcherRoot)

  assert.equal(result.status, 0, result.stderr)
  assert.ok(fake.statusRequests >= 1)
  assert.equal(fake.shutdownRequests, 0)
  assert.match(result.stdout, new RegExp(`CanAI is already running[\\s\\S]+127\\.0\\.0\\.1:${fake.port}`, 'i'))
})

powershellTest('остановщик использует фактический порт из control-файла, даже если исходный PORT отличается', async (t) => {
  const dataDir = await makeTempDir(t)
  const unused = await reserveConsecutivePorts(t, 1)
  await closeServer(unused.servers[0])
  const fake = await startFakeCanAi(t)
  await fs.writeFile(path.join(dataDir, 'runtime-control.json'), JSON.stringify({
    version: 1,
    port: fake.port,
    pid: process.pid,
    instanceId: fake.instanceId,
    shutdownToken: fake.shutdownToken,
  }))

  const result = await runStopper(unused.start, dataDir)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(fake.shutdownRequests, 1)
  assert.equal(fake.server.listening, false)
})

/**
 * ⚠️ Лаунчер открывал адрес и ВЕРИЛ, что браузер по нему пришёл. Chrome с
 * несколькими профилями встречает холодный запуск экраном «Who's using
 * Chrome?» и открытый адрес при этом теряет: приложение работает, порт
 * слушает, а человек смотрит на выбор профиля («канвас не открылся после
 * обновления сам», 09.09.2026). Сервер отмечает, приходил ли кто-нибудь за
 * страницей интерфейса, — по этому оба лаунчера и повторяют заход.
 */
test('оба лаунчера проверяют, что браузер дошёл до интерфейса, и заходят второй раз', () => {
  const windows = fsSync.readFileSync(scriptPath, 'utf8')
  const mac = fsSync.readFileSync(path.join(repoRoot, 'start.command'), 'utf8')

  assert.match(windows, /uiOpened/u, 'Windows-лаунчер обязан спрашивать, открылся ли интерфейс')
  assert.match(windows, /foreach \(\$attempt in 1, 2\)/u, 'вторая попытка попадает уже после выбора профиля')
  assert.match(mac, /uiOpened/u, 'маковский лаунчер обязан спрашивать о том же')
  assert.match(mac, /for attempt in 1 2/u)
  // ⚠️ Ловушка zsh: вторая переменная в одном local не видит первую, и порт
  // получился бы пустым.
  assert.doesNotMatch(mac, /local target="\$1"[^\n]*port=/u)
})

/**
 * ⚠️ Сеть, где наружу пускают только через прокси, нужна уже ПЕРВОМУ запуску —
 * скачиванию Node.js и `npm ci`. Проверка на чистой Windows 28.09.2026 нашла две
 * беды разом: блок прокси стоял перед стартом сервера, то есть ПОСЛЕ `npm ci`,
 * а без сети покупатель видел сырую ошибку PowerShell («CategoryInfo»,
 * «FullyQualifiedErrorId») вместо объяснения, что делать.
 */
test('прокси выбирается до скачивания Node.js и npm ci, а остановка объясняется словами', () => {
  const windows = fsSync.readFileSync(scriptPath, 'utf8')
  const proxy = windows.indexOf('$systemProxy = Get-CanAiSystemProxy')
  assert.ok(proxy > 0, 'системный прокси читается')
  assert.ok(proxy < windows.indexOf('function Install-BundledNode'), 'до скачивания Node.js')
  assert.ok(proxy < windows.indexOf('Sync-CanAiDependencies $pkg'), 'до npm ci')
  assert.match(windows, /\$download\.Proxy = \$downloadProxy/u, 'Node.js качается тем же прокси')
  assert.match(windows, /^trap \{/mu, 'любая остановка перехвачена')
  assert.match(windows, /Could not download Node\.js from nodejs\.org/u)
  assert.equal(windows.charCodeAt(0), 0xfeff, 'UTF-8 с BOM, иначе PowerShell 5.1 ломает кириллицу')
})

/**
 * ⚠️ Сказать про неоткрывшийся браузер может только СЕРВЕР: задание Windows-
 * лаунчера живёт отдельным процессом, и его Write-Host до окна человека не
 * доходит, пока идёт сервер. Заодно он один и знает, приходил ли кто-то за
 * страницей.
 */
test('адрес словами называет сервер, а не фоновое задание лаунчера', () => {
  const windows = fsSync.readFileSync(scriptPath, 'utf8')
  const watcherStart = windows.indexOf('function Start-CanAiBrowserWatcher')
  const watcher = windows.slice(watcherStart, windows.indexOf('# Proxy for the server itself', watcherStart))
  assert.ok(watcher.length > 0, 'наблюдатель за браузером должен существовать')
  assert.doesNotMatch(watcher, /Write-Host/u, 'из задания человек этого не увидит')

  const server = fsSync.readFileSync(path.join(repoRoot, 'server', 'src', 'index.ts'), 'utf8')
  assert.match(server, /Browser did not open the app/u)
  // В режиме разработки страницу раздаёт vite, и за нашей никто не придёт
  // никогда — там молчим.
  assert.match(server, /if \(hasDist\) \{\s*\n\s*setTimeout\(/u)
})

/**
 * ⚠️ Перезапуск сервера НЕ открывает вторую вкладку (жалоба 19.09.2026:
 * «локальная десктопная версия стала постоянно вылетать», на снимках — две
 * конфликтные копии одной доски с разницей в минуту). Наблюдатель за браузером
 * стоял в начале цикла автоперезапуска, то есть открывал окно на КАЖДОЕ
 * падение. У человека при этом первая вкладка никуда не делась и сама
 * возвращалась на связь — и две вкладки на одной доске заставляли сервер
 * писать конфликтную копию. Одно падение оборачивалось задвоенной доской,
 * то есть последствие переживало причину.
 *
 * ⚠️ НОВЫЙ адрес — другое дело: если порт успели занять, лаунчер выбирает
 * следующий, и на том адресе не смотрит никто. Поэтому правило не «никогда
 * не открывать при перезапуске», а «открывать, когда адрес сменился».
 */
test('перезапуск сервера не открывает вторую вкладку на том же адресе', () => {
  const windows = fsSync.readFileSync(scriptPath, 'utf8')
  const mac = fsSync.readFileSync(path.join(repoRoot, 'start.command'), 'utf8')

  const windowsLoop = windows.slice(windows.indexOf('$maxQuickFailures = 3'))
  assert.match(
    windowsLoop,
    /if \(\$openedUrl -ne \$url\) \{[\s\S]*?Start-CanAiBrowserWatcher[\s\S]*?\$openedUrl = \$url/u,
    'Windows-лаунчер обязан открывать браузер только на новый адрес',
  )

  const macLoop = mac.slice(mac.indexOf('MAX_QUICK_FAILURES=3'))
  assert.match(
    macLoop,
    /if \[ "\$opened_url" != "\$URL" \]; then[\s\S]*?watch_browser[\s\S]*?opened_url="\$URL"/u,
    'маковский лаунчер обязан вести себя так же',
  )
  // ⚠️ Наблюдателя теперь может не быть вовсе — снимать его надо с проверкой,
  // иначе kill с пустым аргументом убьёт не то.
  assert.match(macLoop, /if \[ -n "\$watcher" \]; then kill/u)
})

/**
 * ⚠️ Смерть, которую сервер записать НЕ МОЖЕТ: его убили снаружи или он ушёл
 * фатальной ошибкой Node. Обработчики при этом не успевают ничего, и в журнале
 * остаётся просто пробел — а по пробелу «постоянно вылетает» не отличить от
 * «закрыли окно» (жалоба 19–20.09.2026: ни одной записи о падении за десять
 * дней). Записать это может только лаунчер: он переживает сервер.
 */
test('лаунчер записывает в журнал, чем кончился сервер', () => {
  const windows = fsSync.readFileSync(scriptPath, 'utf8')
  const mac = fsSync.readFileSync(path.join(repoRoot, 'start.command'), 'utf8')

  assert.match(windows, /function Write-ServerLogLine/u, 'Windows-лаунчер обязан уметь писать в журнал')
  assert.match(windows, /Write-ServerLogLine "\[launcher\] server stopped, exit code \$exitCode"/u)
  assert.match(mac, /log_server_line\(\)/u, 'маковский лаунчер обязан уметь то же')
  assert.match(mac, /log_server_line "\[launcher\] server stopped, exit code \$exit_code"/u)
})

/**
 * ⚠️ Фатальная ошибка самого Node (нехватка памяти прежде всего) печатается в
 * консоль и исчезает вместе с окном. Штатный отчёт Node оставляет файл с
 * причиной, стеками и памятью — и ничего не стоит, пока всё хорошо.
 */
test('оба лаунчера просят Node оставить отчёт при фатальной ошибке', () => {
  const windows = fsSync.readFileSync(scriptPath, 'utf8')
  const mac = fsSync.readFileSync(path.join(repoRoot, 'start.command'), 'utf8')
  for (const [name, source] of [['Windows', windows], ['macOS', mac]] as const) {
    assert.match(source, /--report-on-fatalerror/u, `${name}: нужен отчёт при фатальной ошибке`)
    assert.match(source, /--report-directory/u, `${name}: отчёт должен лечь рядом с журналом`)
  }
})
