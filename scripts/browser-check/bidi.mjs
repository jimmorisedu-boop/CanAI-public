// Минимальный клиент WebDriver BiDi для Firefox (пункт 5.8).
//
// Запускает ОТДЕЛЬНЫЙ экземпляр Firefox со своим профилем — браузер человека не
// трогается. Своих зависимостей нет: в Node 22+ WebSocket встроен.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Где искать Firefox: явный путь, обычная установка, скачанный приложением для входа. */
export function findFirefox(root) {
  const candidates = [
    process.env.FIREFOX,
    os.platform() === 'win32' ? 'C:/Program Files/Mozilla Firefox/firefox.exe' : null,
    os.platform() === 'win32' ? 'C:/Program Files (x86)/Mozilla Firefox/firefox.exe' : null,
    os.platform() === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : null,
    os.platform() === 'linux' ? '/usr/bin/firefox' : null,
    // Firefox, который приложение докачивает для входа на площадки (extractorLogin).
    path.join(root, 'runtime', 'login-browser', 'firefox', os.platform() === 'win32' ? 'firefox.exe' : 'firefox'),
  ].filter(Boolean)
  return candidates.find((file) => fs.existsSync(file)) ?? null
}

export async function launchFirefox({ binary, profileDir, port = 9333, width = 1600, height = 1000 }) {
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'user.js'), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("startup.homepage_welcome_url", "");',
    'user_pref("app.update.disabledForTesting", true);',
    'user_pref("browser.tabs.warnOnClose", false);',
    // Проверка идёт к своему компьютеру: прокси системы ей только мешает.
    'user_pref("network.proxy.type", 0);',
  ].join('\n'))
  const proc = spawn(binary, [
    '--remote-debugging-port', String(port), '--no-remote', '--new-instance', '--profile', profileDir,
    '--width', String(width), '--height', String(height), 'about:blank',
  ], { stdio: 'ignore' })

  let socket = null
  for (let attempt = 0; attempt < 60 && !socket; attempt += 1) {
    try {
      socket = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/session`)
        ws.onopen = () => resolve(ws)
        ws.onerror = () => reject(new Error('connection failed'))
      })
    } catch {
      await sleep(500)
    }
  }
  if (!socket) {
    proc.kill()
    throw new Error('Firefox did not open the WebDriver BiDi port')
  }

  let nextId = 1
  const pending = new Map()
  socket.onmessage = (message) => {
    const data = JSON.parse(typeof message.data === 'string' ? message.data : message.data.toString())
    const waiter = data.id ? pending.get(data.id) : null
    if (!waiter) return
    pending.delete(data.id)
    if (data.type === 'error') waiter.reject(new Error(`${data.error}: ${data.message}`))
    else waiter.resolve(data.result)
  }
  const send = (method, params = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  await send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } })
  const context = (await send('browsingContext.getTree', {})).contexts[0].context

  /** Выражение в странице; обещания дожидаемся. Результат — строка или примитив. */
  const evaluate = async (expression) => {
    const reply = await send('script.evaluate', {
      expression, target: { context }, awaitPromise: true, resultOwnership: 'none',
    })
    if (reply.type === 'exception') {
      throw new Error(`Page error: ${JSON.stringify(reply.exceptionDetails?.text ?? reply.exceptionDetails)}`)
    }
    return reply.result?.value
  }
  const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`))

  const wheel = (x, y, deltaY) => send('input.performActions', {
    context,
    actions: [{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x, y, deltaX: 0, deltaY }] }],
  })
  /** Перетаскивание средней кнопкой — это панорама холста (как у человека). */
  const panDrag = (x, y, offsets) => send('input.performActions', {
    context,
    actions: [{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x, y },
        { type: 'pointerDown', button: 1 },
        ...offsets.map(([dx, dy]) => ({ type: 'pointerMove', x: x + dx, y: y + dy, duration: 16 })),
        { type: 'pointerUp', button: 1 },
      ],
    }],
  })

  const close = async () => {
    try { await send('browser.close', {}) } catch { /* уже закрыт */ }
    try { socket.close() } catch { /* уже закрыт */ }
    await sleep(1000)
    try { proc.kill() } catch { /* уже вышел */ }
  }
  return { send, evaluate, json, wheel, panDrag, context, close }
}
