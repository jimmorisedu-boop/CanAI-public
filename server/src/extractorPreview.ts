import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { config } from './config.js'
import { PortableMediaTools, type PortableMediaTool } from './portableMediaTools.js'
import { saveBuffer } from './storage.js'
import { jsRuntimeArgs } from './ytRuntime.js'
import { currentCookieArgs } from './extractorCookies.js'
import { terminateProcessTree } from './terminateProcessTree.js'

const MAX_PREVIEW_BYTES = 64 * 1024 * 1024
const TOOL_TIMEOUT_MS = 90_000

type Provider = 'youtube' | 'vimeo' | 'instagram' | 'tiktok'

export interface ExtractorPreviewRunInput {
  executable: string
  args: string[]
  outputDir: string
}

export interface ExtractProviderPreviewInput {
  provider: Provider
  url: string
  entryId: string
  mediaDir?: string
  locate?: (tool: PortableMediaTool) => Promise<string>
  run?: (input: ExtractorPreviewRunInput) => Promise<void>
  savePreview?: (buffer: Buffer, baseName: string) => Promise<string>
  /** Вход на площадку, если человек его задал (extractorCookies.ts). */
  cookieArgs?: () => Promise<string[]>
}

const tools = new PortableMediaTools({ toolsDir: config.mediaToolsDir })

function runExtractor({ executable, args }: ExtractorPreviewRunInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let settled = false
    let stopping = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (!stopping) finish(code === 0 ? undefined : new Error(`extractor preview failed (${code ?? 'unknown'}): ${stderr.slice(0, 300)}`))
    })
    const timer = setTimeout(() => {
      stopping = true
      void terminateProcessTree(child).then(
        () => finish(new Error('The extractor preview timed out')),
        (error: Error) => finish(error),
      )
    }, TOOL_TIMEOUT_MS)
    timer.unref()
  })
}

async function imageFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(candidate)
      else if (entry.isFile()) found.push(candidate)
    }
  }
  await visit(directory)
  return found
}

async function firstValidImage(directory: string): Promise<Buffer | undefined> {
  const root = path.resolve(directory)
  for (const file of await imageFiles(root)) {
    const resolved = path.resolve(file)
    const relative = path.relative(root, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    const stat = await fs.stat(resolved)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PREVIEW_BYTES) continue
    const buffer = await fs.readFile(resolved)
    try {
      await sharp(buffer, { failOn: 'error' }).metadata()
      return buffer
    } catch {
      // Видео или повреждённый файл не подходят как обложка; ищем следующий.
    }
  }
  return undefined
}

function attempts(
  provider: Provider,
  url: string,
  outputDir: string,
  cookies: string[],
): Array<{ tool: PortableMediaTool; args: string[] }> {
  const thumbnail = {
    tool: 'yt-dlp' as const,
    args: [
      ...cookies,
      '--no-warnings', '--skip-download', '--write-thumbnail', '--no-playlist',
      ...jsRuntimeArgs(),
      '-o', path.join(outputDir, 'preview.%(ext)s'), url,
    ],
  }
  if (provider === 'youtube' || provider === 'vimeo') return [thumbnail]
  return [
    thumbnail,
    {
      tool: 'gallery-dl',
      args: [
        ...cookies,
        '--config-ignore', '--no-input', '--range', '1',
        '-D', outputDir, '-f', 'preview.{extension}', url,
      ],
    },
  ]
}

export async function extractProviderPreview(input: ExtractProviderPreviewInput): Promise<string | undefined> {
  const parsed = new URL(input.url)
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return undefined
  const mediaDir = path.resolve(input.mediaDir ?? config.mediaDir)
  const locate = input.locate ?? ((tool) => tools.locate(tool))
  const run = input.run ?? runExtractor
  const savePreview = input.savePreview ?? (async (buffer, baseName) => (
    await saveBuffer(buffer, 'image/webp', baseName)
  ).url)
  const cookieArgs = input.cookieArgs ?? currentCookieArgs
  const cookies = await cookieArgs().catch(() => [])
  await fs.mkdir(mediaDir, { recursive: true })
  const outputDir = await fs.mkdtemp(path.join(mediaDir, '.link-preview-'))

  try {
    for (const attempt of attempts(input.provider, input.url, outputDir, cookies)) {
      try {
        const executable = await locate(attempt.tool)
        await run({ executable, args: attempt.args, outputDir })
        const source = await firstValidImage(outputDir)
        if (!source) continue
        const thumbnail = await sharp(source, { failOn: 'error' })
          .rotate()
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 78 })
          .toBuffer()
        return await savePreview(thumbnail, `link-preview-${input.entryId}`)
      } catch {
        // Превью необязательно: следующий extractor может сработать, а без
        // картинки карточка всё равно должна разрешить скачивание публикации.
      }
    }
    return undefined
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => undefined)
  }
}
