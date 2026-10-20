import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * ⚠️ Холст перерисовывает растры на каждом кадре движения камеры, и браузер
 * каждый раз ужимает их заново. Замер на доске пользователя (24 картинки по
 * 5,9 Мпикс, масштаб 0.29): кадр из оригиналов — 78 мс, первый 942 мс; из
 * уменьшенных копий — 0,03 мс. При бюджете кадра 16 мс это и есть «фризы при
 * передвижении» (жалоба 07.09.2026).
 */
test('media отдаёт экранное превью, а на неудаче — оригинал', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canai-media-preview-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }))
  process.env.CANAI_DATA_DIR = dir
  await mkdir(path.join(dir, 'media'), { recursive: true })

  const sharp = (await import('sharp')).default
  const png = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 30, g: 90, b: 200 } },
  }).png().toBuffer()
  await writeFile(path.join(dir, 'media', 'photo.png'), png)
  // Не картинка: превью для неё не сделать, и это не повод показывать дыру.
  await writeFile(path.join(dir, 'media', 'notes.txt'), 'просто текст')

  const express = (await import('express')).default
  const { attachMediaRoutes } = await import('./mediaRoute.js')
  const app = express()
  attachMediaRoutes(app)
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('нет порта')
  const origin = `http://127.0.0.1:${address.port}`

  const preview = await fetch(`${origin}/media/preview/photo.png?w=300`)
  assert.equal(preview.status, 200)
  assert.equal(preview.headers.get('content-type'), 'image/webp')
  const previewBytes = (await preview.arrayBuffer()).byteLength
  assert.ok(previewBytes * 4 < png.byteLength, `превью ${previewBytes} против оригинала ${png.byteLength}`)

  // Не картинка — отправляем к оригиналу, дыры на месте объекта не будет.
  const fallback = await fetch(`${origin}/media/preview/notes.txt`, { redirect: 'manual' })
  assert.equal(fallback.status, 302)
  assert.equal(fallback.headers.get('location'), '/media/notes.txt')

  // Оригинал по-прежнему отдаётся как был: на нём держатся обрезка и экспорт.
  const original = await fetch(`${origin}/media/photo.png`)
  assert.equal(original.status, 200)
  assert.equal((await original.arrayBuffer()).byteLength, png.byteLength)
})
