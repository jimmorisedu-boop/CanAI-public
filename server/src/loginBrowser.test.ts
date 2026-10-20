import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LoginBrowser,
  LoginBrowserError,
  firefoxArgs,
  firefoxCandidates,
  loginUrlFor,
} from './loginBrowser.js'

test('окно входа открывается СВОИМ профилем и новым окном', () => {
  const args = firefoxArgs('C:/CanAI/data/login-profile', 'https://vimeo.com/log_in')
  // ⚠️ -no-remote обязателен: без него Firefox отдаёт ссылку уже открытому окну
  // человека, вход уходит в чужой профиль, и взять его оттуда нечем.
  assert.equal(args[0], '-no-remote')
  assert.deepEqual(args.slice(1, 3), ['-profile', 'C:/CanAI/data/login-profile'])
  assert.equal(args.at(-1), 'https://vimeo.com/log_in')
})

test('у каждой площадки своя страница входа, у прямой ссылки её нет', () => {
  assert.match(loginUrlFor('vimeo') ?? '', /^https:\/\/vimeo\.com\//)
  assert.match(loginUrlFor('youtube') ?? '', /^https:\/\//)
  assert.match(loginUrlFor('instagram') ?? '', /^https:\/\//)
  assert.match(loginUrlFor('tiktok') ?? '', /^https:\/\//)
  assert.equal(loginUrlFor('direct'), null)
})

test('Firefox ищется по явным путям системы, а не по PATH', () => {
  const windows = firefoxCandidates('win32', { 'ProgramFiles': 'C:/Program Files', 'LOCALAPPDATA': 'C:/Users/me/AppData/Local' })
  assert(windows.every((candidate) => candidate.endsWith('firefox.exe')), windows.join(', '))
  assert(windows.some((candidate) => candidate.includes('Program Files')))
  const mac = firefoxCandidates('darwin', { HOME: '/Users/me' })
  assert(mac.some((candidate) => candidate.startsWith('/Applications/Firefox.app')))
  // Пустое окружение не должно давать путей вида «undefined/Mozilla Firefox».
  assert.deepEqual(firefoxCandidates('win32', {}), [])
})

test('без Firefox окно не открывается и говорит об этом словами', async () => {
  const browser = new LoginBrowser({
    platform: 'win32',
    env: { 'ProgramFiles': 'C:/Program Files' },
    exists: async () => false,
    launch: () => assert.fail('запускать нечего'),
    profileDir: 'C:/CanAI/data/login-profile',
  })
  assert.deepEqual(await browser.state(), { available: false, signedIn: false })
  await assert.rejects(browser.open('vimeo'), (error: unknown) => {
    assert(error instanceof LoginBrowserError)
    assert.match(error.message, /Firefox/)
    // Запасной путь назван прямо в отказе: тупика быть не должно.
    assert.match(error.message, /cookie file/u)
    return true
  })
})

test('для прямой ссылки вход не открывается вовсе', async () => {
  const browser = new LoginBrowser({
    platform: 'win32',
    env: { 'ProgramFiles': 'C:/Program Files' },
    exists: async () => true,
    launch: () => assert.fail('прямой ссылке вход не нужен'),
    profileDir: 'C:/CanAI/data/login-profile',
  })
  await assert.rejects(browser.open('direct'), (error: unknown) => {
    assert(error instanceof LoginBrowserError)
    assert.equal(error.code, 'LOGIN_BROWSER_NO_PROVIDER')
    return true
  })
})

test('окно входа ходит той же дорогой, что и приложение', async (t) => {
  const fsp = await import('node:fs/promises')
  const os = await import('node:os')
  const nodePath = await import('node:path')
  const profileDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'canai-login-proxy-'))
  t.after(() => fsp.rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  const userJs = nodePath.join(profileDir, 'user.js')
  const launched: string[][] = []
  const make = (proxy: () => string | null) => new LoginBrowser({
    platform: 'win32',
    env: { 'ProgramFiles': 'C:/Program Files' },
    exists: async () => true,
    launch: (_executable, args) => { launched.push(args) },
    profileDir,
    proxy,
  })

  await make(() => 'http://127.0.0.1:10808').open('vimeo')
  const written = await fsp.readFile(userJs, 'utf8')
  assert.match(written, /network\.proxy\.http_port", 10808/)
  assert.equal(launched.length, 1)

  // ⚠️ Дорога сменилась на прямую — прежняя настройка обязана ИСЧЕЗНУТЬ, иначе
  // окно продолжит ходить через прокси, которого уже нет.
  await make(() => null).open('vimeo')
  assert.equal(await fsp.access(userJs).then(() => true, () => false), false)
  assert.equal(launched.length, 2)
})
