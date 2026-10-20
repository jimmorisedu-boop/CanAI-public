// Мок-режим: когда нет FAL_KEY, вместо настоящей генерации рисуем SVG-заглушку
// (а для видео — собираем короткий MP4 через ffmpeg), чтобы интерфейс
// можно было проверять бесплатно.

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { config } from './config.js'
import { mediaWritePath } from './mediaLayout.js'
import { requireFfmpeg } from './ffmpegTools.js'
import { selectEncoder } from './mediaOps.js'
import { encoderArgs } from './videoEncoder.js'

const execFileAsync = promisify(execFile)

const PALETTES: Array<[string, string]> = [
  ['#1b2a4a', '#5f7adb'],
  ['#3a1b4a', '#b45fdb'],
  ['#1b4a3a', '#5fdba8'],
  ['#4a2f1b', '#dba25f'],
  ['#4a1b28', '#db5f7a'],
]

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

const NAMED_IMAGE_RATIOS: Record<string, number> = {
  square: 1,
  square_hd: 1,
  portrait_4_3: 3 / 4,
  portrait_16_9: 9 / 16,
  landscape_4_3: 4 / 3,
  landscape_16_9: 16 / 9,
}

function parseMockRatio(value: unknown): number | null {
  if (typeof value === 'string') {
    if (NAMED_IMAGE_RATIOS[value]) return NAMED_IMAGE_RATIOS[value]
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value)
    if (match) {
      const width = Number(match[1])
      const height = Number(match[2])
      if (width > 0 && height > 0) return width / height
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const size = value as Record<string, unknown>
    if (typeof size.width === 'number' && size.width > 0
      && typeof size.height === 'number' && size.height > 0) {
      return size.width / size.height
    }
  }
  return null
}

function mockDimensions(params: Record<string, unknown>): { width: number; height: number } {
  const ratio = parseMockRatio(params.image_size) ?? parseMockRatio(params.aspect_ratio)
  if (!ratio) return { width: 1024, height: 768 }
  return ratio >= 1
    ? { width: 1024, height: Math.max(1, Math.round(1024 / ratio)) }
    : { width: Math.max(1, Math.round(1024 * ratio)), height: 1024 }
}

export function mockImage(
  prompt: string,
  imageRefs = 0,
  textRefs = 0,
  params: Record<string, unknown> = {},
): { buffer: Buffer; width: number; height: number } {
  const { width, height } = mockDimensions(params)
  let hash = 0
  for (const ch of prompt) hash = (hash + ch.charCodeAt(0)) % 997
  const [from, to] = PALETTES[hash % PALETTES.length]
  const line1 = escapeXml(prompt.slice(0, 45))
  const refNote = [
    imageRefs > 0 ? `${imageRefs}×image` : null,
    textRefs > 0 ? `${textRefs}×text` : null,
  ]
    .filter(Boolean)
    .join(', ')
  const line2 = escapeXml(refNote ? `references: ${refNote}` : prompt.slice(45, 90))

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <circle cx="${Math.round(width * 0.8)}" cy="${Math.round(height * 0.22)}" r="${Math.round(Math.min(width, height) * 0.17)}" fill="rgba(255,255,255,.10)"/>
  <circle cx="${Math.round(width * 0.68)}" cy="${Math.round(height * 0.39)}" r="${Math.round(Math.min(width, height) * 0.08)}" fill="rgba(255,255,255,.08)"/>
  <text x="60" y="${height - 168}" font-family="Segoe UI, sans-serif" font-size="36" fill="rgba(255,255,255,.94)">${line1}</text>
  <text x="60" y="${height - 118}" font-family="Segoe UI, sans-serif" font-size="36" fill="rgba(255,255,255,.94)">${line2}</text>
  <text x="60" y="${height - 62}" font-family="Segoe UI, sans-serif" font-size="20" fill="rgba(255,255,255,.55)">CanAI · demo-image (no key fal — enter it in Settings)</text>
</svg>`

  return { buffer: Buffer.from(svg, 'utf8'), width, height }
}

// Мок-ответ LLM: короткий осмысленный текст на основе промпта.
export function mockText(prompt: string): string {
  const userLines = [...prompt.matchAll(/(?:Пользователь|User)(?:\s+\[[^\]]+\])?:\s*([^\n]+)/g)]
  const request = (userLines.at(-1)?.[1] ?? 'idea user').trim().slice(0, 220)
  const countMatch = request.match(/(\d+)\s*(?:фото|видео|картинок|изображений|вариант|промпт|photo|photos|video|videos|image|images|variant|variants|prompt|prompts)/i)
  const requestedCount = countMatch ? Math.min(10, Math.max(1, parseInt(countMatch[1], 10))) : 2

  const preferredModelMatch = prompt.match(/(?:Основная модель пользователя для картинок|User's preferred image model):\s*([^\n(]+)/i)
  const preferredModel = preferredModelMatch ? preferredModelMatch[1].trim() : null

  const prompts = Array.from({ length: requestedCount }, (_, i) => ({
    title: `Variant ${i + 1}`,
    prompt: preferredModel
      ? `${request} — variant ${i + 1} (style ${preferredModel}). Expressive composition, natural light, high detail.`
      : `${request} — variant ${i + 1}. Expressive composition, natural light, high detail.`,
  }))

  return JSON.stringify({
    reply: preferredModel
      ? `Demo assistant response: prepared ${requestedCount} variants for model ${preferredModel} with the board style considered.`
      : `Demo assistant response: prepared ${requestedCount} variants for canvas generation.`,
    prompts,
  })
}


// Пишет двухсекундный цветной MP4 сразу в папку медиа и возвращает URL.
export async function mockVideo(jobId: string): Promise<{ url: string; width: number; height: number }> {
  const tools = await requireFfmpeg()
  // В переносимой LGPL-сборке default MP4 — MPEG-4 Part 2, который браузер
  // не воспроизводит. Предпочитаем программный H.264 без зависимости от GPU.
  const encoder = await selectEncoder(true)
  if (!encoder) throw new Error('The build has no H.264 encoder for demo video')
  const fileName = `${jobId}.mp4`
  const outPath = await mediaWritePath(fileName)
  // Пишем во временный файл и переименовываем: при сбое ffmpeg в media не
  // остаётся битый partial, который потом неделями раздаётся как настоящий.
  const tmpPath = await mediaWritePath(`${jobId}.tmp.mp4`)
  try {
    await execFileAsync(tools.ffmpeg, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=0x2a3f5f:s=1024x576:d=2:r=24',
      '-c:v', encoder, ...encoderArgs(encoder),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tmpPath,
    ], { windowsHide: true })
    await fs.rename(tmpPath, outPath)
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined)
    throw new Error(`Could not build mock video: ${(err as Error).message?.slice(0, 200)}`)
  }
  return { url: `/media/${fileName}`, width: 1024, height: 576 }
}
