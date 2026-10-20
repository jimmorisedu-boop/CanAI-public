import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LoginBrowserInstall } from './loginBrowserInstall.js'

async function temporaryDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'canai-login-browser-'))
}

function assetStream(bytes: number): { ok: true; status: 200; body: ReadableStream<Uint8Array>; size: number } {
  const chunk = new Uint8Array(bytes)
  return {
    ok: true,
    status: 200,
    size: bytes,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.close()
      },
    }),
  }
}

test('закачка кладёт браузер в папку приложения и убирает установщик', async (t) => {
  const runtimeDir = await temporaryDir()
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  const install = new LoginBrowserInstall({
    runtimeDir,
    platform: 'win32',
    fetchAsset: async () => assetStream(2048),
    extract: async (installer, target) => {
      // Установщик обязан существовать к моменту распаковки: он скачан файлом.
      assert(await fs.stat(installer).then((s) => s.isFile(), () => false))
      await fs.mkdir(path.join(target, 'core'), { recursive: true })
      await fs.writeFile(path.join(target, 'core', 'firefox.exe'), 'ff')
      // Так делает настоящий установщик: кладёт рядом свою копию (замер
      // 18.09.2026 — в папке оказались core, postSigningData и setup.exe).
      await fs.writeFile(path.join(target, 'setup.exe'), 'installer')
    },
  })

  assert.deepEqual(install.getState(), { state: 'missing' })
  const executable = await install.prepare()
  assert.equal(executable, path.join(runtimeDir, 'core', 'firefox.exe'))
  assert.deepEqual(install.getState(), { state: 'ready', executable, source: 'runtime' })
  // ⚠️ Ни скачанного установщика (93 МБ), ни его копии из архива в папке
  // остаться не должно: двойной клик по такой копии ставит Firefox в СИСТЕМУ,
  // а весь этот путь затевался ради портативности.
  const leftovers = await fs.readdir(runtimeDir)
  assert.deepEqual(leftovers.filter((name) => name.includes('setup')), [])
  assert(leftovers.includes('core'))
})

test('вторая попытка не качает заново, а отдаёт уже скачанное', async (t) => {
  const runtimeDir = await temporaryDir()
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  await fs.mkdir(path.join(runtimeDir, 'core'), { recursive: true })
  await fs.writeFile(path.join(runtimeDir, 'core', 'firefox.exe'), 'ff')
  let downloads = 0
  const install = new LoginBrowserInstall({
    runtimeDir,
    platform: 'win32',
    fetchAsset: async () => { downloads += 1; return assetStream(16) },
    extract: async () => assert.fail('распаковывать нечего'),
  })

  await install.prepare()
  assert.equal(downloads, 0)
  assert.equal(install.getState().state, 'ready')
})

test('сбой закачки не оставляет мусора и объясняется словами', async (t) => {
  const runtimeDir = await temporaryDir()
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  const install = new LoginBrowserInstall({
    runtimeDir,
    platform: 'win32',
    fetchAsset: async () => ({ ok: false, status: 503, body: null, size: null }),
    extract: async () => assert.fail('до распаковки дело не дойдёт'),
  })

  await assert.rejects(install.prepare(), /503/)
  const state = install.getState()
  assert.equal(state.state, 'failed')
  assert.deepEqual(await fs.readdir(runtimeDir), [])
})

test('распаковка без firefox.exe считается неудачей, а не готовностью', async (t) => {
  const runtimeDir = await temporaryDir()
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  const install = new LoginBrowserInstall({
    runtimeDir,
    platform: 'win32',
    fetchAsset: async () => assetStream(64),
    // Распаковалось что-то не то: сказать «готов» тут значило бы обещать окно,
    // которое потом не откроется.
    extract: async (_installer, target) => { await fs.mkdir(path.join(target, 'core'), { recursive: true }) },
  })

  await assert.rejects(install.prepare(), /firefox\.exe/)
  assert.equal(install.getState().state, 'failed')
})

test('на маке и линуксе не качаем, но и тупика нет: ищем системный', async (t) => {
  const runtimeDir = await temporaryDir()
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  const install = new LoginBrowserInstall({
    runtimeDir,
    platform: 'darwin',
    systemExecutable: async () => '/Applications/Firefox.app/Contents/MacOS/firefox',
    fetchAsset: async () => assert.fail('на маке качать нечего'),
  })

  assert.equal(await install.locate(), '/Applications/Firefox.app/Contents/MacOS/firefox')
  assert.deepEqual(install.getState(), {
    state: 'ready',
    executable: '/Applications/Firefox.app/Contents/MacOS/firefox',
    source: 'system',
  })

  const withoutSystem = new LoginBrowserInstall({ runtimeDir, platform: 'darwin' })
  assert.equal(await withoutSystem.locate(), null)
  assert.equal(withoutSystem.getState().state, 'unsupported')
  await assert.rejects(withoutSystem.prepare(), /installed normally/u)
})

test('системная копия не выдаётся за свою: источник назван честно', async (t) => {
  const runtimeDir = await temporaryDir()
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  const install = new LoginBrowserInstall({
    runtimeDir,
    platform: 'win32',
    systemExecutable: async () => 'C:/Program Files/Mozilla Firefox/firefox.exe',
  })
  await install.locate()
  const state = install.getState()
  assert.equal(state.state === 'ready' && state.source, 'system')
})
