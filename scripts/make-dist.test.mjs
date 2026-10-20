import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PUBLIC_HELP_SCREENSHOT_NAMES } from './public-release-config.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const windowsOnly = { skip: process.platform !== 'win32' }
const macosOnly = { skip: process.platform !== 'darwin' }
const SCREENSHOT_NAMES = [...PUBLIC_HELP_SCREENSHOT_NAMES]

function assertInside(parent, child) {
  const relative = path.relative(parent, child)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `temporary path must stay inside ${parent}: ${child}`)
}

async function fixture(t, { tablet = true, license = true, scanner = true, publicProtocol = true, help = true, gettingStarted = true } = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'canai-make-dist-'))
  const resolved = await fs.realpath(directory)
  assertInside(temporaryRoot, resolved)
  t.after(async () => {
    assert.equal(await fs.realpath(directory), resolved)
    assertInside(temporaryRoot, resolved)
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 })
  })

  const install = path.join(resolved, 'CanAI fixture')
  await fs.mkdir(install)
  assertInside(resolved, await fs.realpath(install))
  // Only the real packaging script is copied from the checkout. All inputs,
  // including the intentionally excluded secrets, are synthetic fixtures.
  await fs.copyFile(path.join(root, 'make-dist.ps1'), path.join(install, 'make-dist.ps1'))
  const files = {
    'client/dist/index.html': '<!doctype html><title>CanAI fixture</title>',
    'client/public/fonts/OFL.txt': 'fixture font license',
    'client/node_modules/excluded.txt': 'excluded dependency',
    'server/src/index.ts': 'export {}',
    'packages/model-catalog/catalog.ts': 'export const CATALOG = []',
    'docs/agents/protocol.schema.json': '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:test:protocol"}',
    'docs/agents/canai.agent.schema.json': '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:test:manifest"}',
    'docs/agents/README.md': 'private protocol notes',
    'docs/agents/CLOUD.md': 'private cloud notes',
    'docs/agents/IMPLEMENTATION.md': 'private implementation notes',
    'docs/agents/ADAPTATION.md': 'private adaptation notes',
    'docs/public/AGENT-PROTOCOL.md': '# Public protocol\n',
    'docs/GETTING-STARTED.md': '# Getting started\n',
    'docs/help/README.md': '# Help\n',
    'docs/help/quick-start.md': '# Start a local board\n',
    ...Object.fromEntries(SCREENSHOT_NAMES.map((name) => [
      `docs/images/${name}.jpg`, `synthetic ${name} screenshot fixture`,
    ])),
    'docs/images/assistant.png': 'legacy screenshot fixture',
    'server/.env': 'FAL_KEY=synthetic-test-key',
    'server/.env.backup': 'FAL_KEY=synthetic-backup-key',
    'server/data/projects.json': '{"private":"synthetic board"}',
    'server/node_modules/excluded.txt': 'excluded dependency',
    'package.json': '{"name":"canai-fixture","private":true}',
    'package-lock.json': '{"lockfileVersion":3}',
    'start.ps1': '# fixture launcher',
    'stop.ps1': '# fixture stop',
    'Start CanAI.bat': '@echo off',
    'Stop CanAI.bat': '@echo off',
    // Перенос данных из прежней версии (пункт 5.4) едет покупателю.
    'Migrate data.bat': '@echo off',
    'migrate-data.ps1': '# fixture migration',
    'USER-GUIDE.md': 'fixture instructions',
    'THIRD-PARTY-NOTICES.md': 'fixture notices',
    'THIRD-PARTY-LICENSES.txt': 'fixture license\n'.repeat(1000),
    // ⚠️ Полные тексты LGPL едут ОТДЕЛЬНОЙ папкой, и на неё прямым текстом
    // ссылается THIRD-PARTY-NOTICES.md. В Windows-поставке её не было вовсе,
    // хотя ffmpeg и LAME к покупателю попадают (найдено разбором 17.09.2026).
    'licenses/ffmpeg-LGPL-2.1.txt': 'fixture LGPL text',
    // Планшетная страница ДЛЯ СЕРВЕРА КОМАНДЫ: 28 МБ, которые покупателю
    // не открыть ничем — в поставке её быть не должно.
    'client/dist-tablet-cloud/tablet.html': '<!doctype html><title>Cloud tablet</title>',
    'LICENSE': 'CanAI Community License 1.0\n',
    'README.md': '# CanAI fixture\n',
    'TABLET-GUIDE.md': 'Tablet guide\n',
    'CHANGELOG.md': '# Changelog\n',
    'SECURITY.md': '# Security\n',
    'scripts/generate-third-party.mjs': 'export {}\n',
    'scripts/scan-secrets.mjs': 'export {}\n',
    'scripts/excluded.txt': 'build tooling',
    'runtime/excluded.txt': 'local runtime',
    'update.ps1': '# developer updater',
  }
  if (tablet) files['client/dist/tablet/tablet.html'] = '<!doctype html><title>Tablet fixture</title>'
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(install, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  if (!license) await fs.rm(path.join(install, 'LICENSE'))
  if (!scanner) await fs.rm(path.join(install, 'scripts/scan-secrets.mjs'))
  if (!publicProtocol) await fs.rm(path.join(install, 'docs/public/AGENT-PROTOCOL.md'))
  if (!help) await fs.rm(path.join(install, 'docs/help'), { recursive: true, force: true })
  if (!gettingStarted) await fs.rm(path.join(install, 'docs/GETTING-STARTED.md'), { force: true })

  // npm is the only build/network boundary. Robocopy, package validation,
  // Compress-Archive and Get-FileHash execute unchanged on the actual files.
  const wrapper = path.join(install, 'run-test.ps1')
  await fs.writeFile(wrapper, `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function npm {
    $line = $args -join ' '
    # Build number (fix list item 5.1): the real script asks git; here it is
    # synthetic, but it must land in the package folder given as the last arg.
    # PowerShell drops '--' when calling a function; the real npm receives it.
    if ($line -like '--prefix server run build-info *') {
        [IO.File]::WriteAllText((Join-Path $args[-1] 'build-info.json'), '{"commit":"0123456789ab","date":"2026-09-26T12:00:00+03:00"}')
        $global:LASTEXITCODE = 0
        return
    }
    if ($line -notin @('run check', 'run licenses', 'run build')) {
        throw "unexpected npm invocation: $args"
    }
    $global:LASTEXITCODE = 0
}
function node {
    $line = $args -join ' '
    if ($line -like '*generate-third-party.mjs*') {
        [IO.File]::WriteAllText($args[-1], ('license' + [Environment]::NewLine) * 2000)
        $global:LASTEXITCODE = 0
        return
    }
    if ($line -like '*scan-secrets.mjs*' -and $line -like '*--require-gitleaks*') {
        $global:LASTEXITCODE = 0
        return
    }
    throw 'node/network access is not part of the packaging fixture'
}
& (Join-Path $PSScriptRoot 'make-dist.ps1')
`)
  return { install, wrapper }
}

async function runPowerShell(script, cwd, extraArgs = []) {
  // Windows PowerShell must discover its own modules when npm was launched
  // by PowerShell 7 (inheriting PS7's Utility module hides Get-FileHash).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
  return execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extraArgs,
  ], { cwd, env, windowsHide: true, timeout: 30_000, encoding: 'utf8' })
}

test('release ZIP builds without removed relay credentials and excludes local data', windowsOnly, async (t) => {
  const { install, wrapper } = await fixture(t)
  await runPowerShell(wrapper, install)
  const packages = path.join(install, 'dist-package')
  const archives = (await fs.readdir(packages)).filter((name) => name.endsWith('.zip'))
  assert.equal(archives.length, 1, 'packager must produce one release ZIP')
  const zip = path.join(packages, archives[0])
  const expectedHash = createHash('sha256').update(await fs.readFile(zip)).digest('hex')
  assert.equal((await fs.readFile(`${zip}.sha256`, 'utf8')).trim(), `${expectedHash}  ${archives[0]}`)

  const inspect = path.join(install, 'inspect-zip.ps1')
  await fs.writeFile(inspect, `
param([string]$Zip)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
try { ConvertTo-Json -InputObject @($archive.Entries | ForEach-Object { $_.FullName }) -Compress }
finally { $archive.Dispose() }
`)
  const inspected = await runPowerShell(inspect, install, [zip])
  const contents = JSON.parse(inspected.stdout).map((name) => name.replaceAll('\\', '/').split('/').slice(1).join('/'))
  const expectedScreenshots = SCREENSHOT_NAMES.map((name) => `docs/images/${name}.jpg`)
  for (const included of [
    'client/dist/index.html', 'client/dist/tablet/tablet.html', 'client/public/fonts/OFL.txt',
    'server/src/index.ts', 'start.ps1', 'stop.ps1', 'Start CanAI.bat',
    'Stop CanAI.bat', 'LICENSE', 'README.md', 'USER-GUIDE.md', 'TABLET-GUIDE.md',
    'CHANGELOG.md', 'SECURITY.md', 'THIRD-PARTY-LICENSES.txt',
    'licenses/ffmpeg-LGPL-2.1.txt',
    ...expectedScreenshots,
    'docs/GETTING-STARTED.md', 'docs/help/README.md', 'docs/help/quick-start.md',
    // Номер сборки (пункт 5.1): у покупателя нет .git, и без файла разбор
    // жалобы начинается с угадывания версии.
    'build-info.json',
    'Migrate data.bat', 'migrate-data.ps1',
    'docs/agents/protocol.schema.json', 'docs/agents/canai.agent.schema.json', 'docs/agents/README.md',
  ]) assert.ok(contents.includes(included), `ZIP must include ${included}`)
  assert.deepEqual(
    contents.filter((entry) => entry.startsWith('docs/images/') && !entry.endsWith('/')).sort(),
    expectedScreenshots.slice().sort(),
    'ZIP must contain exactly the approved Help screenshots',
  )
  assert.equal(contents.includes('docs/images/assistant.png'), false, 'ZIP must exclude the legacy PNG screenshot')
  for (const privateDoc of ['docs/agents/CLOUD.md', 'docs/agents/IMPLEMENTATION.md', 'docs/agents/ADAPTATION.md']) {
    assert.equal(contents.includes(privateDoc), false, `ZIP must exclude ${privateDoc}`)
  }
  for (const entry of contents) {
    assert.doesNotMatch(entry, /(^|\/)(?:data|node_modules|runtime|scripts|dist-tablet-cloud)(?:\/|$)|(?:^|\/)\.env|share-(?:relay|enrollment)|^update\.ps1$/,
      `ZIP must exclude local data, development tooling and removed relay: ${entry}`)
  }
})

test('release ZIP is rejected when the tablet page was not built', windowsOnly, async (t) => {
  const { install, wrapper } = await fixture(t, { tablet: false })
  await assert.rejects(runPowerShell(wrapper, install), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /missing built page: client\\dist\\tablet\\tablet.html/)
    return true
  })
  const entries = await fs.readdir(path.join(install, 'dist-package'))
  assert.equal(entries.some((name) => name.endsWith('.zip')), false)
})

test('release ZIP is rejected when generated Help pages are missing', windowsOnly, async (t) => {
  const { install, wrapper } = await fixture(t, { help: false })
  await assert.rejects(runPowerShell(wrapper, install), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /required file is missing: docs\\help/u)
    return true
  })
  const entries = await fs.readdir(path.join(install, 'dist-package'))
  assert.equal(entries.some((name) => name.endsWith('.zip')), false)
})

test('release ZIP is rejected when getting-started guide is missing', windowsOnly, async (t) => {
  const { install, wrapper } = await fixture(t, { gettingStarted: false })
  await assert.rejects(runPowerShell(wrapper, install), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /required file is missing: docs\\GETTING-STARTED\.md/u)
    return true
  })
  const entries = await fs.readdir(path.join(install, 'dist-package'))
  assert.equal(entries.some((name) => name.endsWith('.zip')), false)
})

test('release ZIP is rejected when the project license is missing', windowsOnly, async (t) => {
  const { install, wrapper } = await fixture(t, { license: false })
  await assert.rejects(runPowerShell(wrapper, install), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /required file is missing: LICENSE/u)
    return true
  })
  const entries = await fs.readdir(path.join(install, 'dist-package'))
  assert.equal(entries.some((name) => name.endsWith('.zip')), false)
})

test('release ZIP is rejected when the secret scanner is missing', windowsOnly, async (t) => {
  const { install, wrapper } = await fixture(t, { scanner: false })
  await assert.rejects(runPowerShell(wrapper, install), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /secret scanner is missing/u)
    return true
  })
  const entries = await fs.readdir(path.join(install, 'dist-package'))
  assert.equal(entries.some((name) => name.endsWith('.zip')), false)
})

async function fixtureMacos(t, { tablet = true, license = true, scanner = true, help = true, gettingStarted = true } = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'canai-make-dist-macos-'))
  const resolved = await fs.realpath(directory)
  assertInside(temporaryRoot, resolved)
  t.after(async () => {
    assert.equal(await fs.realpath(directory), resolved)
    assertInside(temporaryRoot, resolved)
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 })
  })

  const install = path.join(resolved, 'CanAI-fixture')
  await fs.mkdir(install)
  assertInside(resolved, await fs.realpath(install))

  await fs.copyFile(path.join(root, 'make-dist.sh'), path.join(install, 'make-dist.sh'))
  await fs.chmod(path.join(install, 'make-dist.sh'), 0o755)

  const ffmpegSrc = path.join(root, 'runtime/media-tools/ffmpeg')
  const ffprobeSrc = path.join(root, 'runtime/media-tools/ffprobe')

  const files = {
    'client/dist/index.html': '<!doctype html><title>CanAI fixture</title>',
    'client/public/fonts/OFL.txt': 'fixture font license',
    'client/node_modules/excluded.txt': 'excluded dependency',
    'server/src/index.ts': 'export {}',
    'package.json': '{"name":"canai-fixture","private":true}',
    'package-lock.json': '{"lockfileVersion":3}',
    'LICENSE': 'CanAI Community License 1.0\n',
    'start.command': '#!/bin/zsh\n',
    'stop.command': '#!/bin/zsh\n',
    'Start CanAI.command': '#!/bin/zsh\n',
    'Stop CanAI.command': '#!/bin/zsh\n',
    'README.md': '# CanAI fixture\n',
    'USER-GUIDE.md': 'fixture instructions',
    'TABLET-GUIDE.md': 'Tablet guide\n',
    'CHANGELOG.md': '# Changelog\n',
    'SECURITY.md': '# Security\n',
    'THIRD-PARTY-NOTICES.md': 'fixture notices',
    'THIRD-PARTY-LICENSES.txt': 'fixture license\n'.repeat(1000),
    'licenses/license.txt': 'fixture license text',
    'packages/shared/index.ts': 'export {}',
    'docs/agents/protocol.schema.json': '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:test:protocol"}',
    'docs/agents/canai.agent.schema.json': '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:test:manifest"}',
    'docs/agents/README.md': 'private protocol notes',
    'docs/agents/CLOUD.md': 'private cloud notes',
    'docs/agents/IMPLEMENTATION.md': 'private implementation notes',
    'docs/agents/ADAPTATION.md': 'private adaptation notes',
    'docs/public/AGENT-PROTOCOL.md': '# Public protocol\n',
    'docs/GETTING-STARTED.md': '# Getting started\n',
    'docs/help/README.md': '# Help\n',
    'docs/help/quick-start.md': '# Start a local board\n',
    ...Object.fromEntries(SCREENSHOT_NAMES.map((name) => [
      `docs/images/${name}.jpg`, `synthetic ${name} screenshot fixture`,
    ])),
    'docs/images/assistant.png': 'legacy screenshot fixture',
    'Migrate data.command': '#!/bin/zsh\n',
    'migrate-data.command': '#!/bin/zsh\n',
    'scripts/generate-third-party.mjs': 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "license\\n".repeat(2000));',
    'scripts/scan-secrets.mjs': 'if (!process.argv.includes("--require-gitleaks")) process.exit(2);',
    'update.ps1': '# developer updater',
  }
  if (tablet) files['client/dist/tablet/tablet.html'] = '<!doctype html><title>Tablet fixture</title>'

  for (const [name, content] of Object.entries(files)) {
    const target = path.join(install, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  if (!license) await fs.rm(path.join(install, 'LICENSE'))
  if (!scanner) await fs.rm(path.join(install, 'scripts/scan-secrets.mjs'))
  if (!help) await fs.rm(path.join(install, 'docs/help'), { recursive: true, force: true })
  if (!gettingStarted) await fs.rm(path.join(install, 'docs/GETTING-STARTED.md'), { force: true })

  for (const cmd of [
    'start.command', 'stop.command', 'Start CanAI.command', 'Stop CanAI.command',
    'Migrate data.command', 'migrate-data.command',
    'docs/agents/protocol.schema.json', 'docs/agents/canai.agent.schema.json',
  ]) {
    await fs.chmod(path.join(install, cmd), 0o755)
  }

  const mediaToolsDir = path.join(install, 'runtime/media-tools')
  await fs.mkdir(mediaToolsDir, { recursive: true })
  await fs.copyFile(ffmpegSrc, path.join(mediaToolsDir, 'ffmpeg'))
  await fs.copyFile(ffprobeSrc, path.join(mediaToolsDir, 'ffprobe'))
  await fs.chmod(path.join(mediaToolsDir, 'ffmpeg'), 0o755)
  await fs.chmod(path.join(mediaToolsDir, 'ffprobe'), 0o755)

  const binDir = path.join(install, 'mock-bin')
  await fs.mkdir(binDir, { recursive: true })
  const mockNpm = path.join(binDir, 'npm')
  await fs.writeFile(mockNpm, `#!/bin/sh
case "$*" in
  *"run build-info"*)
    for last; do true; done
    echo '{"commit":"fixture","builtAt":"2026-09-27T00:00:00Z"}' > "$last/build-info.json"
    exit 0
    ;;
  *"run check"*|*"run build"*|*"run licenses"*) exit 0 ;;
  *) echo "unexpected npm: $*" >&2; exit 1 ;;
esac
`)
  await fs.chmod(mockNpm, 0o755)

  return { install, binDir }
}

test('macOS: release ZIP builds with ditto, creates sha256 and preserves executable bits', macosOnly, async (t) => {
  const { install, binDir } = await fixtureMacos(t)
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  await execFileAsync('zsh', [path.join(install, 'make-dist.sh')], { cwd: install, env })

  const packages = path.join(install, 'dist-package')
  const archives = (await fs.readdir(packages)).filter((name) => name.endsWith('.zip'))
  assert.equal(archives.length, 1, 'packager must produce one release ZIP')
  const zip = path.join(packages, archives[0])
  const expectedHash = createHash('sha256').update(await fs.readFile(zip)).digest('hex')
  assert.equal((await fs.readFile(`${zip}.sha256`, 'utf8')).trim(), `${expectedHash}  ${archives[0]}`)

  const archiveContents = await execFileAsync('tar', ['-tf', zip])
  const entries = archiveContents.stdout.trim().split('\n').map((name) => name.split('/').slice(1).join('/').normalize('NFC'))
  const expectedScreenshots = SCREENSHOT_NAMES.map((name) => `docs/images/${name}.jpg`)
  for (const included of [
    'client/dist/index.html', 'client/dist/tablet/tablet.html', 'client/public/fonts/OFL.txt',
    'server/src/index.ts', 'packages/shared/index.ts', 'build-info.json',
    'start.command', 'stop.command', 'Start CanAI.command', 'Stop CanAI.command',
    'Migrate data.command', 'migrate-data.command',
    'LICENSE', 'README.md', 'USER-GUIDE.md', 'TABLET-GUIDE.md', 'CHANGELOG.md', 'SECURITY.md',
    'THIRD-PARTY-LICENSES.txt',
    'runtime/media-tools/ffmpeg', 'runtime/media-tools/ffprobe',
    'docs/GETTING-STARTED.md', 'docs/help/README.md', 'docs/help/quick-start.md',
    ...expectedScreenshots,
  ]) {
    assert.ok(entries.includes(included), `ZIP must include ${included}`)
  }
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith('docs/images/') && !entry.endsWith('/')).sort(),
    expectedScreenshots.slice().sort(),
    'ZIP must contain exactly the approved Help screenshots',
  )
  assert.equal(entries.includes('docs/images/assistant.png'), false, 'ZIP must exclude the legacy PNG screenshot')
  for (const entry of entries) {
    assert.doesNotMatch(entry, /(^|\/)(?:data|node_modules|scripts)(?:\/|$)|(?:^|\/)\.env|^update\.ps1$/,
      `ZIP must exclude local data, development scripts and secrets: ${entry}`)
  }
})

test('macOS: release ZIP is rejected when the tablet page was not built', macosOnly, async (t) => {
  const { install, binDir } = await fixtureMacos(t, { tablet: false })
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  await assert.rejects(
    execFileAsync('zsh', [path.join(install, 'make-dist.sh')], { cwd: install, env }),
    (error) => {
      assert.match(error.stderr, /the package has no tablet page/)
      return true
    }
  )
})

test('macOS: release ZIP is rejected when generated Help pages are missing', macosOnly, async (t) => {
  const { install, binDir } = await fixtureMacos(t, { help: false })
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  await assert.rejects(
    execFileAsync('zsh', [path.join(install, 'make-dist.sh')], { cwd: install, env }),
    (error) => {
      assert.match(error.stderr, /required file is missing: docs\/help/u)
      return true
    },
  )
})

test('macOS: release ZIP is rejected when getting-started guide is missing', macosOnly, async (t) => {
  const { install, binDir } = await fixtureMacos(t, { gettingStarted: false })
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  await assert.rejects(
    execFileAsync('zsh', [path.join(install, 'make-dist.sh')], { cwd: install, env }),
    (error) => {
      assert.match(error.stderr, /required file is missing: docs\/GETTING-STARTED\.md/u)
      return true
    },
  )
})

test('macOS: release ZIP is rejected when the project license is missing', macosOnly, async (t) => {
  const { install, binDir } = await fixtureMacos(t, { license: false })
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  await assert.rejects(
    execFileAsync('zsh', [path.join(install, 'make-dist.sh')], { cwd: install, env }),
    (error) => {
      assert.match(error.stderr, /required file is missing: LICENSE/u)
      return true
    }
  )
})

test('macOS: release ZIP is rejected when the secret scanner is missing', macosOnly, async (t) => {
  const { install, binDir } = await fixtureMacos(t, { scanner: false })
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  await assert.rejects(
    execFileAsync('zsh', [path.join(install, 'make-dist.sh')], { cwd: install, env }),
    (error) => {
      assert.match(error.stderr, /secret scanner is missing/u)
      return true
    },
  )
})
