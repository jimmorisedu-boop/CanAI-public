import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { mediaWritePathIn } from './mediaLayout.js'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { MediaImportItem, MediaImportTask, MediaLinkPreview } from './mediaImportTypes.js'
import { resolveMediaLink, type ResolvedMediaEntry, type ResolvedMediaLink } from './mediaLinkResolver.js'
import { downloadRemoteMedia, type DownloadRemoteMediaInput } from './safeRemote.js'
import { mimeForExt } from './mediaTypes.js'
import type { PortableMediaTool } from './portableMediaTools.js'
import { normalizeMediaLink } from './mediaLinkUrl.js'
import { jsRuntimeArgs } from './ytRuntime.js'
import { ffmpegBinary } from './ffmpegTools.js'
import { terminateProcessTree } from './terminateProcessTree.js'
import { needsExtractorLogin } from './extractorLogin.js'
import { currentCookieArgs } from './extractorCookies.js'

// Потолок на один файл. Поднят с 512 МБ, когда скачивание перевели на
// максимальное качество: 4K-ролик на десять минут весит больше гигабайта, и
// прежний лимит рубил бы ровно то, ради чего качество и повышали. Сам потолок
// нужен: он не даёт одному битому адресу залить весь диск.
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024
const PROGRESS_WRITE_MS = 250

export interface MediaImportStoreLike {
  load(): Promise<MediaImportTask[]>
  list(): Promise<MediaImportTask[]>
  get(id: string): Promise<MediaImportTask | null>
  upsert(task: MediaImportTask): Promise<void>
}

interface YtDownloadInput {
  executable: string
  args: string[]
  signal: AbortSignal
  onProgress: (received: number, total?: number) => void
}

interface MediaImportManagerDeps {
  store: MediaImportStoreLike
  mediaDir: string
  resolve?: (url: string) => Promise<ResolvedMediaLink>
  downloadRemote?: (input: DownloadRemoteMediaInput) => Promise<{ url: string; mime: string; bytes: number }>
  locateTool?: (tool: PortableMediaTool) => Promise<string>
  runYtDlp?: (input: YtDownloadInput) => Promise<{ path: string }>
  /** Вход на площадку, если человек его задал (extractorCookies.ts). */
  cookieArgs?: () => Promise<string[]>
  now?: () => number
  id?: () => string
  concurrency?: number
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Could not download media'
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500)
}

function publicDownloadError(
  provider: MediaImportTask['provider'],
  download: ResolvedMediaEntry['download'],
  error: unknown,
): string {
  // «Нужен вход в аккаунт» — не поломка и не битая ссылка, а решение площадки;
  // сказать это надо прямо, иначе человек ищет беду в своей ссылке (см.
  // extractorLogin.ts). Текст тут литеральный, вывод extractor'а наружу не идёт.
  if (needsExtractorLogin(safeError(error))) {
    return 'The platform serves video only after account sign-in; click “Sign in” on the link card'
  }
  // Vimeo extractor output may contain a local executable path, cookies or
  // other provider diagnostics. Keep the persisted task safe and stable while
  // retaining the previous detailed behavior for every other provider.
  if (provider === 'vimeo' && download.type === 'yt-dlp') return 'Could not download the Vimeo video'
  return safeError(error)
}

function isActive(status: MediaImportTask['status']): boolean {
  return status === 'queued' || status === 'preparing' || status === 'downloading' || status === 'processing'
}

function resultName(url: string, fallback: string): string {
  const name = url.split('/').at(-1)?.split('?')[0]
  return name || fallback
}

function defaultRunYtDlp(input: YtDownloadInput): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    // Отмена могла прийти, пока locateTool/ffmpegBinary.locate ещё ожидались.
    if (input.signal.aborted) { reject(new Error('Download cancelled')); return }
    const child = spawn(input.executable, input.args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let stopping = false
    const onAbort = () => {
      if (settled || stopping) return
      stopping = true
      void terminateProcessTree(child).then(
        () => finish(new Error('Download cancelled')),
        (error: Error) => finish(error),
      )
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
    const finish = (error?: Error, file?: string) => {
      if (settled) return
      settled = true
      input.signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ path: file! })
    }
    const consumeLines = () => {
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const progress = /^canai:(\d+):(?:(\d+))?$/.exec(line.trim())
        if (progress) input.onProgress(Number(progress[1]), progress[2] ? Number(progress[2]) : undefined)
        const result = /^canai-result:(.+)$/.exec(line.trim())
        if (result) Object.assign(child, { __canaiResult: result[1] })
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); consumeLines() })
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString('utf8') })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (stopping) return
      consumeLines()
      if (input.signal.aborted) finish(new Error('Download cancelled'))
      else if (code !== 0) finish(new Error(`yt-dlp could not download the video: ${stderr.slice(0, 300)}`))
      else {
        const file = (child as typeof child & { __canaiResult?: string }).__canaiResult
        finish(file ? undefined : new Error('yt-dlp did not report the downloaded file path'), file)
      }
    })
  })
}

export class MediaImportManager {
  private readonly store: MediaImportStoreLike
  private readonly mediaDir: string
  private readonly resolveLink: (url: string) => Promise<ResolvedMediaLink>
  private readonly downloadRemote: NonNullable<MediaImportManagerDeps['downloadRemote']>
  private readonly locateTool: NonNullable<MediaImportManagerDeps['locateTool']>
  private readonly runYtDlp: NonNullable<MediaImportManagerDeps['runYtDlp']>
  private readonly cookieArgs: NonNullable<MediaImportManagerDeps['cookieArgs']>
  private readonly now: () => number
  private readonly makeId: () => string
  private readonly concurrency: number
  private readonly queued: string[] = []
  private readonly running = new Set<string>()
  private readonly runningTasks = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly resolved = new Map<string, ResolvedMediaLink>()
  private readonly resolving = new Map<string, Promise<ResolvedMediaLink>>()
  private readonly progressTimers = new Map<string, NodeJS.Timeout>()
  private readonly idleWaiters = new Set<() => void>()
  private disposed = false

  constructor(deps: MediaImportManagerDeps) {
    this.store = deps.store
    this.mediaDir = deps.mediaDir
    this.resolveLink = deps.resolve ?? resolveMediaLink
    this.downloadRemote = deps.downloadRemote ?? downloadRemoteMedia
    this.locateTool = deps.locateTool ?? (async () => { throw new Error('yt-dlp is not configured') })
    this.runYtDlp = deps.runYtDlp ?? defaultRunYtDlp
    this.cookieArgs = deps.cookieArgs ?? currentCookieArgs
    this.now = deps.now ?? Date.now
    this.makeId = deps.id ?? randomUUID
    this.concurrency = deps.concurrency ?? 2
  }

  async preview(url: string): Promise<MediaLinkPreview> {
    return clone((await this.resolveShared(url)).public)
  }

  async create(input: { url: string; entryIds?: string[] }): Promise<MediaImportTask> {
    if (this.disposed) throw new Error('Queue download stopped')
    const resolved = await this.resolveShared(input.url)
    const wanted = input.entryIds ? new Set(input.entryIds) : null
    const selected = resolved.entries.filter((entry) => !wanted || wanted.has(entry.id))
    if (selected.length === 0 || (wanted && selected.length !== wanted.size)) throw new Error('Selected media not found in publication')
    const now = this.now()
    const id = this.makeId()
    const task: MediaImportTask = {
      id,
      sourceUrl: resolved.public.normalizedUrl,
      provider: resolved.public.provider,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      items: selected.map(({ download: _download, ...entry }) => ({
        ...entry,
        status: 'queued',
        downloadedBytes: 0,
      })),
    }
    this.resolved.set(id, { ...resolved, entries: selected })
    await this.store.upsert(task)
    this.queued.push(id)
    this.pump()
    return clone(task)
  }

  get(id: string): Promise<MediaImportTask | null> {
    return this.store.get(id)
  }

  async cancel(id: string): Promise<MediaImportTask> {
    const task = await this.store.get(id)
    if (!task) throw new Error('Download job not found')
    if (!isActive(task.status)) {
      if (task.status === 'cancelled') await this.runningTasks.get(id)
      return task
    }
    this.controllers.get(id)?.abort()
    const queueIndex = this.queued.indexOf(id)
    if (queueIndex >= 0) this.queued.splice(queueIndex, 1)
    task.status = 'cancelled'
    task.updatedAt = this.now()
    for (const item of task.items) {
      if (item.status !== 'completed' && item.status !== 'error') item.status = 'cancelled'
    }
    await this.persistImmediate(task)
    // Windows освобождает .part только после завершения всего дерева
    // загрузчика. Чужие задачи при этом ждать не нужно.
    await this.runningTasks.get(id)
    await this.cleanupParts(id)
    this.resolveIdleIfNeeded()
    return clone(task)
  }

  async recoverInterrupted(): Promise<void> {
    const tasks = await this.store.list()
    for (const task of tasks) {
      if (!isActive(task.status)) continue
      task.status = 'interrupted'
      task.updatedAt = this.now()
      task.error = 'Download was interrupted by a CanAI restart. You can retry.'
      for (const item of task.items) {
        if (isActive(item.status)) item.status = 'interrupted'
      }
      await this.store.upsert(task)
      await this.cleanupParts(task.id)
    }
  }

  waitForIdle(): Promise<void> {
    if (this.queued.length === 0 && this.running.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const ids = [...this.queued, ...this.running]
    await Promise.all(ids.map((id) => this.cancel(id).catch(() => undefined)))
    await this.waitForIdle()
    for (const timer of this.progressTimers.values()) clearTimeout(timer)
    this.progressTimers.clear()
  }

  private pump(): void {
    while (!this.disposed && this.running.size < this.concurrency && this.queued.length > 0) {
      const id = this.queued.shift()!
      this.running.add(id)
      const runningTask = this.runTask(id).finally(() => {
        this.running.delete(id)
        this.runningTasks.delete(id)
        this.controllers.delete(id)
        this.resolved.delete(id)
        this.pump()
        this.resolveIdleIfNeeded()
      })
      this.runningTasks.set(id, runningTask)
    }
    this.resolveIdleIfNeeded()
  }

  private resolveShared(url: string): Promise<ResolvedMediaLink> {
    const key = normalizeMediaLink(url).url
    const current = this.resolving.get(key)
    if (current) return current
    const created = this.resolveLink(key).finally(() => {
      if (this.resolving.get(key) === created) this.resolving.delete(key)
    })
    this.resolving.set(key, created)
    return created
  }

  private async runTask(id: string): Promise<void> {
    const task = await this.store.get(id)
    const resolved = this.resolved.get(id)
    if (!task || !resolved || task.status === 'cancelled') return
    const controller = new AbortController()
    this.controllers.set(id, controller)
    task.status = 'preparing'
    task.updatedAt = this.now()
    await this.persistImmediate(task)

    for (const item of task.items) {
      if (controller.signal.aborted || (await this.store.get(id))?.status === 'cancelled') break
      const entry = resolved.entries.find((candidate) => candidate.id === item.id)
      if (!entry) {
        item.status = 'error'
        item.error = 'Media item not found in the publication'
        continue
      }
      item.status = 'downloading'
      item.stage = 'Download'
      task.status = 'downloading'
      task.updatedAt = this.now()
      await this.persistImmediate(task)
      try {
        const result = await this.downloadEntry(task, item, entry, controller.signal)
        if (controller.signal.aborted) throw new Error('Download cancelled')
        item.status = 'processing'
        item.stage = 'Preparation file'
        task.status = 'processing'
        task.updatedAt = this.now()
        await this.persistImmediate(task)
        item.status = 'completed'
        item.stage = undefined
        item.result = result
        item.percent = 100
      } catch (error) {
        if (controller.signal.aborted) {
          item.status = 'cancelled'
          item.error = undefined
          break
        }
        item.status = 'error'
        item.stage = undefined
        item.error = publicDownloadError(task.provider, entry.download, error)
      }
      task.updatedAt = this.now()
      await this.persistImmediate(task)
    }

    const current = await this.store.get(id)
    if (controller.signal.aborted || current?.status === 'cancelled') {
      task.status = 'cancelled'
      for (const item of task.items) if (item.status === 'queued' || item.status === 'downloading' || item.status === 'processing') item.status = 'cancelled'
      await this.cleanupParts(id)
    } else if (task.items.some((item) => item.status === 'completed')) {
      task.status = 'completed'
    } else {
      task.status = 'error'
      task.error = 'Could not download media from publication'
    }
    task.updatedAt = this.now()
    await this.persistImmediate(task)
  }

  private async downloadEntry(
    task: MediaImportTask,
    item: MediaImportItem,
    entry: ResolvedMediaEntry,
    signal: AbortSignal,
  ): Promise<NonNullable<MediaImportItem['result']>> {
    const onProgress = (received: number, total?: number) => {
      item.downloadedBytes = Math.max(item.downloadedBytes, received)
      if (total !== undefined) item.totalBytes = Math.max(item.totalBytes ?? 0, total)
      if (item.totalBytes) item.percent = Math.min(99, Math.round((item.downloadedBytes / item.totalBytes) * 100))
      task.updatedAt = this.now()
      this.scheduleProgressPersist(task)
    }
    const baseName = `media-import-${task.id}-${entry.id}`
    if (entry.download.type === 'remote') {
      const result = await this.downloadRemote({
        url: entry.download.url,
        mediaDir: this.mediaDir,
        baseName,
        maxBytes: MAX_MEDIA_BYTES,
        headers: entry.download.headers,
        signal,
        onProgress,
      })
      item.downloadedBytes = Math.max(item.downloadedBytes, result.bytes)
      return { url: result.url, mime: result.mime, name: resultName(result.url, entry.title) }
    }

    const executable = await this.locateTool('yt-dlp')
    const outputTemplate = path.join(this.mediaDir, `${task.id}-${entry.id}.part.%(ext)s`)
    // Вход на площадку (если задан) — первым: дальше идут формат и шаблон
    // имени, а ссылка всегда последней.
    const common = [
      ...await this.cookieArgs().catch(() => []),
      '--newline', '--no-playlist',
      ...jsRuntimeArgs(),
      '--progress-template', 'canai:%(progress.downloaded_bytes)s:%(progress.total_bytes_estimate)s',
      '--print', 'after_move:canai-result:%(filepath)s',
      '-o', outputTemplate,
    ]

    // МАКСИМАЛЬНОЕ качество — это ОТДЕЛЬНЫЕ дорожки видео и звука: всё выше
    // 1080p отдаётся только так, единым файлом не бывает вовсе. Склеивает их
    // ffmpeg — наш портативный компонент; без него склеивать нечем, поэтому
    // раздельных попыток просто не будет.
    const ffmpeg = await ffmpegBinary.locate().catch(() => null)
    const merged = ffmpeg
      ? [
        '--ffmpeg-location', path.dirname(ffmpeg.ffmpeg),
        '--merge-output-format', 'mp4',
        // mp4-дорожки предпочтительнее при равном качестве: их понимает всё.
        // Потолка по высоте нет — 4K берём даже в VP9/AV1.
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba',
      ]
      : null

    // ⚠️ Дорожки высокого качества YouTube отдаёт НЕ ВСЯКОМУ клиенту, и от
    // выбора клиента зависит, скачается ли файл целиком. Замерено вживую
    // 19.08.2026 на десятиминутном ролике: клиент по умолчанию (android_vr)
    // показывает всю лесенку до 2160p, но CDN обрывает отдачу на ~61 МБ с
    // «HTTP Error 403» — и так на каждой попытке, включая скачивание кусками;
    // клиенты tv/mweb/ios/tv_simply честно отдают только 360p (формат 18); а
    // web_embedded скачал дорожку 1080p60 целиком (245 МБ) без единого
    // обрыва, и на втором ролике дал настоящие 3840×2160 со звуком (401+140,
    // 243 МБ). Поэтому первым делом просим именно его.
    //
    // Дальше — ступеньки вниз, на случай если у ролика запрещено встраивание
    // (тогда web_embedded не получит вообще ничего): клиенты по умолчанию с
    // тем же максимальным качеством, а в самом конце лучший ЕДИНЫЙ поток —
    // он есть всегда. Первая удавшаяся попытка выигрывает, так что при
    // нормальной ссылке лишних скачиваний не происходит.
    const attempts: string[][] = [
      ...(merged ? [['--extractor-args', 'youtube:player_client=web_embedded', ...merged]] : []),
      ...(merged ? [merged] : []),
      ['-f', 'b'],
    ]

    let downloaded: Awaited<ReturnType<typeof this.runYtDlp>> | null = null
    let lastError: unknown = null
    for (const formatArgs of attempts) {
      try {
        downloaded = await this.runYtDlp({
          executable,
          signal,
          onProgress,
          args: [...common, ...formatArgs, entry.download.url],
        })
        break
      } catch (error) {
        // Отмену повтором не перебиваем: человек нажал «Стоп».
        if (signal?.aborted) throw error
        lastError = error
        // Обрыв оставляет недокачанный кусок (замер: 61 МБ), а следующая
        // попытка пишет под другим именем — без уборки этот мусор осел бы в
        // media до ближайшей сборки мусора.
        await this.cleanupParts(task.id).catch(() => {})
      }
    }
    if (!downloaded) throw lastError instanceof Error ? lastError : new Error('yt-dlp could not download a video')
    const source = path.resolve(downloaded.path)
    const mediaRoot = `${path.resolve(this.mediaDir)}${path.sep}`
    if (!source.startsWith(mediaRoot)) throw new Error('yt-dlp returned a file outside the media folder')
    const stat = await fs.stat(source)
    if (!stat.isFile() || stat.size === 0) throw new Error('yt-dlp returned empty file')
    if (stat.size > MAX_MEDIA_BYTES) throw new Error('Video too large')
    const ext = path.extname(source).slice(1).toLowerCase() || 'mp4'
    const finalName = `${baseName}.${ext}`
    // Кладём в папку по типу (mediaLayout): yt-dlp пишет .part-файл в корень,
    // а готовый результат переезжает туда, где его потом найдут руками.
    const finalPath = await mediaWritePathIn(this.mediaDir, finalName)
    await fs.rename(source, finalPath)
    item.downloadedBytes = Math.max(item.downloadedBytes, stat.size)
    const mime = mimeForExt(ext)
    const result: NonNullable<MediaImportItem['result']> = {
      url: `/media/${finalName}`,
      mime,
      name: finalName,
    }
    if (mime.startsWith('image/')) {
      const metadata = await sharp(finalPath).metadata().catch(() => null)
      if (metadata?.width) result.width = metadata.width
      if (metadata?.height) result.height = metadata.height
    }
    return result
  }

  private scheduleProgressPersist(task: MediaImportTask): void {
    if (this.progressTimers.has(task.id)) return
    const timer = setTimeout(() => {
      this.progressTimers.delete(task.id)
      void this.store.upsert(task).catch(() => undefined)
    }, PROGRESS_WRITE_MS)
    timer.unref()
    this.progressTimers.set(task.id, timer)
  }

  private async persistImmediate(task: MediaImportTask): Promise<void> {
    const timer = this.progressTimers.get(task.id)
    if (timer) clearTimeout(timer)
    this.progressTimers.delete(task.id)
    await this.store.upsert(task)
  }

  private async cleanupParts(taskId: string): Promise<void> {
    let files: string[]
    try {
      files = await fs.readdir(this.mediaDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const prefixes = [`${taskId}-`, `media-import-${taskId}-`]
    await Promise.all(files
      .filter((file) => prefixes.some((prefix) => file.startsWith(prefix)) && file.includes('.part'))
      .map((file) => fs.rm(path.join(this.mediaDir, file), { force: true })))
  }

  private resolveIdleIfNeeded(): void {
    if (this.queued.length > 0 || this.running.size > 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
