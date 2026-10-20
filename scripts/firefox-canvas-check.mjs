#!/usr/bin/env node
// Скорость холста в Firefox перед выпуском (пункт 5.8 списка исправлений).
//
//   node scripts/firefox-canvas-check.mjs [--images 150] [--port 8796] [--keep]
//
// Зачем: 25.09.2026 холст в Firefox давал 7–13 кадров в секунду на доске,
// где Chrome держал 60, — крупные копии картинок копились после приближения,
// а Firefox перезаливал их текстурами на каждом кадре. В Chrome этого не видно
// вовсе, поэтому беду ловит только прогон в самом Firefox.
//
// Что делает: собирает интерфейс в СВОЮ папку и поднимает свой сервер со своей
// папкой данных (живое приложение и его доски не трогаются), кладёт на доску
// сотню-другую крупных картинок, открывает ОТДЕЛЬНЫЙ Firefox со своим профилем и
// проходит путь человека: вся доска в кадре → приблизил и разглядывает → отдалил
// колесом → двигает. Замеры — с дожиданием холста (см. browser-check/probe.js).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFirefox, launchFirefox } from './browser-check/bidi.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const IMAGES = Math.max(20, Number(option('images', '150')))
const SERVER_PORT = Number(option('port', '8796'))
const PREVIEW_PORT = SERVER_PORT + 10
const BIDI_PORT = SERVER_PORT + 20
const KEEP = args.includes('--keep')

// Пороги взяты из замера 25.09.2026 на доске из 143 картинок: после починки
// кадр 14 мс и 60 к/с, до неё — 85 мс и 13 к/с. Запас намеренный: сторож
// ловит ВОЗВРАТ беды, а не колебания машины.
const LIMITS = { drawP50Ms: 40, panFps: 30, bigCopiesAfterZoomOut: 0 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const children = []

function start(label, command, commandArgs, options) {
  const child = spawn(command, commandArgs, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let tail = ''
  const keep = (chunk) => { tail = (tail + chunk).slice(-4000) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  children.push(child)
  return { child, tail: () => tail, label }
}

function run(label, command, commandArgs, options) {
  return new Promise((resolve, reject) => {
    const proc = start(label, command, commandArgs, options)
    proc.child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label}: exit code ${code}\n${proc.tail()}`))))
  })
}

async function waitHttp(url, proc, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) throw new Error(`${proc.label} stopped:\n${proc.tail()}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* ещё поднимается */ }
    await sleep(500)
  }
  throw new Error(`${proc.label} did not respond within ${timeoutMs / 1000}s:\n${proc.tail()}`)
}

/** Картинки 1536×2048 разных цветов: в памяти браузера весит размер, а не сюжет. */
async function seedBoard(server) {
  const sharp = createRequire(path.join(root, 'server', 'package.json'))('sharp')
  const cols = 15
  const items = []
  const files = Array.from({ length: IMAGES }, (_, index) => index)
  const upload = async (index) => {
    const hue = (index * 37) % 360
    const [r, g, b] = [0, 120, 240].map((shift) => Math.round(127 + 100 * Math.cos(((hue + shift) * Math.PI) / 180)))
    const buffer = await sharp({ create: { width: 1536, height: 2048, channels: 3, background: { r, g, b } } })
      .jpeg({ quality: 80 }).toBuffer()
    const response = await fetch(`${server}/api/assets/upload`, {
      method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: buffer,
    })
    if (!response.ok) throw new Error(`image upload ${index}: HTTP ${response.status}`)
    const { url } = await response.json()
    items[index] = {
      id: `perf-${index}`, kind: 'image', src: url, mime: 'image/jpeg', name: `check-${index}.jpg`,
      x: (index % cols) * 340, y: Math.floor(index / cols) * 440, w: 300, h: 400,
      naturalWidth: 1536, naturalHeight: 2048,
    }
  }
  for (let offset = 0; offset < files.length; offset += 6) {
    await Promise.all(files.slice(offset, offset + 6).map(upload))
  }
  const response = await fetch(`${server}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Firefox performance check', initialSnapshot: { version: 1, items, camera: { x: 0, y: 0, scale: 1 } } }),
  })
  if (!response.ok) throw new Error(`could not create board: HTTP ${response.status} ${await response.text()}`)
  return (await response.json()).project.id
}

async function measure(ff, cx, cy) {
  const waitLoaded = async (rounds = 40) => {
    let state
    for (let round = 0; round < rounds; round += 1) {
      await sleep(700)
      state = await ff.json('window.__canvasProbe.status()')
      if (state.images > 0 && state.loaded === state.images) break
    }
    return state
  }
  const state = await waitLoaded()
  await sleep(1500)
  const draw = await ff.json('window.__canvasProbe.drawCost(8)')
  const steps = await ff.json('window.__canvasProbe.steps()')
  await ff.evaluate('window.__canvasProbe.recordStart()')
  const offsets = Array.from({ length: 80 }, (_, i) => [Math.round(Math.sin(i / 12) * 260), Math.round(Math.cos(i / 17) * 90)])
  await ff.panDrag(cx, cy, offsets)
  const pan = await ff.json('window.__canvasProbe.recordStop()')
  return { scale: state.scale, images: state.images, loaded: state.loaded, draw, pan, steps }
}

function line(label, result) {
  const copies = Object.entries(result.steps).map(([step, count]) => `${step}×${count}`).join(', ')
  return `${label}: scale ${result.scale}, images ${result.loaded}/${result.images}; `
    + `draw ${result.draw?.p50} ms (p95 ${result.draw?.p95}); pan ${result.pan?.fps} fps; copies: ${copies}`
}

async function main() {
  const firefox = findFirefox(root)
  if (!firefox) throw new Error('Firefox was not found — install it or set FIREFOX=<path to firefox>')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canai-firefox-check-'))
  const server = `http://127.0.0.1:${SERVER_PORT}`
  const page = `http://127.0.0.1:${PREVIEW_PORT}`
  let ff = null
  try {
    console.log('Building the app in an isolated directory…')
    const vite = path.join(root, 'client', 'node_modules', 'vite', 'bin', 'vite.js')
    await run('build', process.execPath, [vite, 'build', '--outDir', path.join(temp, 'dist'), '--emptyOutDir'], { cwd: path.join(root, 'client') })

    console.log('Starting the isolated server and page…')
    fs.writeFileSync(path.join(temp, 'empty.env'), '')
    const serverProc = start('server', process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.join(root, 'server'),
      env: {
        ...process.env, CANAI_MOCK: '1', CANAI_DATA_DIR: path.join(temp, 'data'),
        CANAI_ENV_FILE: path.join(temp, 'empty.env'), PORT: String(SERVER_PORT), CANAI_SHARE_PORT: String(SERVER_PORT + 1),
      },
    })
    await waitHttp(`${server}/api/status`, serverProc)
    const previewProc = start('page', process.execPath, [vite, 'preview', '--outDir', path.join(temp, 'dist'), '--port', String(PREVIEW_PORT), '--strictPort'], {
      cwd: path.join(root, 'client'), env: { ...process.env, CANAI_SERVER_URL: server },
    })
    await waitHttp(page, previewProc)

    console.log(`Adding ${IMAGES} 1536×2048 images to the board…`)
    const board = await seedBoard(server)

    ff = await launchFirefox({ binary: firefox, profileDir: path.join(temp, 'profile'), port: BIDI_PORT, width: 1600, height: 1000 })
    await ff.send('browsingContext.navigate', { context: ff.context, url: `${page}/?project=${board}`, wait: 'complete' })
    for (let i = 0; i < 60 && !(await ff.evaluate('Boolean(window.Konva && window.Konva.stages && window.Konva.stages[0])')); i += 1) await sleep(1000)
    await ff.evaluate(fs.readFileSync(path.join(root, 'scripts', 'browser-check', 'probe.js'), 'utf8'))
    const ua = await ff.evaluate('navigator.userAgent')
    const rect = await ff.json(`document.querySelector('.konva-wrap').getBoundingClientRect()`)
    const cx = Math.round(rect.x + rect.width / 2)
    const cy = Math.round(rect.y + rect.height / 2.6)
    // «Показать всё» — Shift+1, как у человека (кнопки масштаба на холсте нет).
    const fit = async () => {
      // Клавиша Shift в WebDriver — служебный код U+E008.
      const shift = String.fromCharCode(0xE008)
      await ff.send('input.performActions', {
        context: ff.context,
        actions: [{ type: 'key', id: 'keyboard', actions: [
          { type: 'keyDown', value: shift }, { type: 'keyDown', value: '1' },
          { type: 'keyUp', value: '1' }, { type: 'keyUp', value: shift },
        ] }],
      })
      await sleep(800)
    }

    await fit()
    const first = await measure(ff, cx, cy)
    console.log(line('Full board in view', first))

    // Как человек: приблизился колесом и разглядывает, потом отдалил колесом же.
    for (let i = 0; i < 60 && (await ff.json('window.__canvasProbe.status()')).scale < 2.4; i += 1) {
      await ff.wheel(cx, cy, -120)
      await sleep(120)
    }
    // Размах жестов — в пределах окна: указатель за краем BiDi не двигает.
    for (const offsets of [[[-300, 0], [-560, 0]], [[0, -120], [0, -220]], [[300, 0], [560, 60]]]) {
      await ff.panDrag(cx, cy, offsets)
      await sleep(1500)
    }
    for (let i = 0; i < 80 && (await ff.json('window.__canvasProbe.status()')).scale > first.scale; i += 1) {
      await ff.wheel(cx, cy, 120)
      await sleep(200)
    }
    const second = await measure(ff, cx, cy)
    console.log(line('After zooming in and out', second))

    const problems = []
    for (const [label, result] of [['full board', first], ['after zooming out', second]]) {
      if ((result.draw?.p50 ?? Infinity) > LIMITS.drawP50Ms) problems.push(`${label}: draw ${result.draw?.p50} ms > ${LIMITS.drawP50Ms}`)
      if ((result.pan?.fps ?? 0) < LIMITS.panFps) problems.push(`${label}: pan ${result.pan?.fps} fps < ${LIMITS.panFps}`)
    }
    const big = (second.steps['1920'] ?? 0) + (second.steps.original ?? 0)
    if (big > LIMITS.bigCopiesAfterZoomOut) problems.push(`large copies remained after zooming out: ${big}`)

    const report = { at: new Date().toISOString(), firefox: ua, images: IMAGES, first, second, limits: LIMITS, problems }
    fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify(report, null, 2))
    console.log(`\n${ua.replace(/^.*\) /u, '')}`)
    if (problems.length) {
      console.log(`FAILED:\n  ${problems.join('\n  ')}`)
      process.exitCode = 1
    } else {
      console.log('PASS: Firefox canvas performance is within limits.')
    }
    if (KEEP) console.log(`Run directory: ${temp}`)
  } finally {
    if (ff) await ff.close()
    for (const child of children) { try { child.kill() } catch { /* уже вышел */ } }
    await sleep(1000)
    if (!KEEP) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  for (const child of children) { try { child.kill() } catch { /* уже вышел */ } }
  process.exitCode = 2
})
