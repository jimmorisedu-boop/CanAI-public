import { createHash, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type PortableMediaTool = 'gallery-dl' | 'yt-dlp'
export type PortableToolState =
  | { state: 'missing' }
  | { state: 'downloading'; percent?: number }
  | { state: 'ready'; path: string }
  | { state: 'failed'; message: string }
  | { state: 'unsupported' }

export interface PortableToolAsset {
  repo: string
  asset: string
  fileName: string
}

export interface GitHubReleaseAsset {
  name: string
  browser_download_url: string
  digest?: string | null
  size?: number
}

export interface GitHubRelease {
  tag_name: string
  assets: GitHubReleaseAsset[]
}

export interface PortableMediaToolsDeps {
  toolsDir: string
  platform?: () => NodeJS.Platform
  arch?: () => string
  now?: () => number
  fetchRelease?: (repo: string) => Promise<GitHubRelease>
  fetchAsset?: (url: string) => Promise<{
    body: ReadableStream<Uint8Array> | null
    size?: number | null
  }>
}

export interface LocatePortableToolOptions {
  onProgress?: (received: number, total: number | undefined, percent: number | undefined) => void
  forceRefresh?: boolean
}

interface ReleaseReceipt {
  tag: string
  asset: string
  digest: string
  checkedAt: number
}

const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const GITHUB_USER_AGENT = 'CanAI-portable-media-tools/1.0'
const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/i

export function portableToolAsset(
  tool: PortableMediaTool,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PortableToolAsset | null {
  if (tool === 'gallery-dl') {
    if (platform === 'win32' && arch === 'x64') {
      return { repo: 'gdl-org/builds', asset: 'gallery-dl_windows.exe', fileName: 'gallery-dl.exe' }
    }
    if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
      return { repo: 'gdl-org/builds', asset: 'gallery-dl_linux', fileName: 'gallery-dl' }
    }
    if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
      return { repo: 'gdl-org/builds', asset: 'gallery-dl_macos', fileName: 'gallery-dl' }
    }
    return null
  }

  if (platform === 'win32' && arch === 'x64') {
    return { repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp.exe', fileName: 'yt-dlp.exe' }
  }
  if (platform === 'win32' && arch === 'arm64') {
    return { repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_arm64.exe', fileName: 'yt-dlp.exe' }
  }
  if (platform === 'linux' && arch === 'x64') {
    return { repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_linux', fileName: 'yt-dlp' }
  }
  if (platform === 'linux' && arch === 'arm64') {
    return { repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_linux_aarch64', fileName: 'yt-dlp' }
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return { repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_macos', fileName: 'yt-dlp' }
  }
  return null
}

function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false)
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) hash.update(chunk as Buffer)
    return `sha256:${hash.digest('hex')}`
  } finally {
    await handle.close()
  }
}

function digestsEqual(actual: string, expected: string): boolean {
  const actualMatch = SHA256_DIGEST.exec(actual)
  const expectedMatch = SHA256_DIGEST.exec(expected)
  if (!actualMatch || !expectedMatch) return false
  return timingSafeEqual(Buffer.from(actualMatch[1], 'hex'), Buffer.from(expectedMatch[1], 'hex'))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not prepare the media loader'
}

export class PortableMediaTools {
  private readonly deps: Required<Pick<PortableMediaToolsDeps, 'toolsDir'>> & Omit<Required<PortableMediaToolsDeps>, 'toolsDir'>
  private readonly states = new Map<PortableMediaTool, PortableToolState>()
  private readonly operations = new Map<PortableMediaTool, Promise<string>>()
  private readonly progress = new Map<PortableMediaTool, Set<NonNullable<LocatePortableToolOptions['onProgress']>>>()

  constructor(input: PortableMediaToolsDeps) {
    this.deps = {
      toolsDir: input.toolsDir,
      platform: input.platform ?? (() => process.platform),
      arch: input.arch ?? (() => process.arch),
      now: input.now ?? Date.now,
      fetchRelease: input.fetchRelease ?? (async (repo) => {
        const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': GITHUB_USER_AGENT },
        })
        if (!response.ok) throw new Error(`GitHub release unavailable (HTTP ${response.status})`)
        return await response.json() as GitHubRelease
      }),
      fetchAsset: input.fetchAsset ?? (async (url) => {
        const response = await fetch(url, { headers: { 'User-Agent': GITHUB_USER_AGENT }, redirect: 'follow' })
        if (!response.ok) throw new Error(`Binary file unavailable (HTTP ${response.status})`)
        const rawSize = Number(response.headers.get('content-length'))
        return {
          body: response.body,
          size: Number.isSafeInteger(rawSize) && rawSize > 0 ? rawSize : undefined,
        }
      }),
    }
  }

  getState(tool: PortableMediaTool): PortableToolState {
    return this.states.get(tool) ?? { state: 'missing' }
  }

  locate(tool: PortableMediaTool, options: LocatePortableToolOptions = {}): Promise<string> {
    const listener = options.onProgress
    if (listener) {
      const listeners = this.progress.get(tool) ?? new Set()
      listeners.add(listener)
      this.progress.set(tool, listeners)
    }

    let operation = this.operations.get(tool)
    if (!operation) {
      operation = this.locateInternal(tool, options.forceRefresh === true)
        .finally(() => this.operations.delete(tool))
      this.operations.set(tool, operation)
    }
    return operation.finally(() => {
      if (!listener) return
      const listeners = this.progress.get(tool)
      listeners?.delete(listener)
      if (listeners?.size === 0) this.progress.delete(tool)
    })
  }

  private emitProgress(tool: PortableMediaTool, received: number, total: number | undefined): void {
    const percent = total ? Math.min(100, Math.round((received / total) * 100)) : undefined
    this.states.set(tool, { state: 'downloading', percent })
    for (const listener of this.progress.get(tool) ?? []) listener(received, total, percent)
  }

  private paths(tool: PortableMediaTool, selected: PortableToolAsset): {
    target: string
    receipt: string
  } {
    return {
      target: path.join(this.deps.toolsDir, selected.fileName),
      receipt: path.join(this.deps.toolsDir, `${tool}.release.json`),
    }
  }

  private async verifiedLocal(tool: PortableMediaTool, selected: PortableToolAsset): Promise<{
    path: string
    receipt: ReleaseReceipt
  } | null> {
    const files = this.paths(tool, selected)
    try {
      const receipt = JSON.parse(await fs.readFile(files.receipt, 'utf8')) as ReleaseReceipt
      if (receipt.asset !== selected.asset || !SHA256_DIGEST.test(receipt.digest)) return null
      if (!await exists(files.target)) return null
      const actual = await fileSha256(files.target)
      if (!digestsEqual(actual, receipt.digest)) return null
      return { path: files.target, receipt }
    } catch {
      return null
    }
  }

  private async locateInternal(tool: PortableMediaTool, forceRefresh: boolean): Promise<string> {
    const selected = portableToolAsset(tool, this.deps.platform(), this.deps.arch())
    if (!selected) {
      this.states.set(tool, { state: 'unsupported' })
      throw new Error(`For this system ${tool} not supported`)
    }
    const local = await this.verifiedLocal(tool, selected)
    if (local && !forceRefresh) {
      this.states.set(tool, { state: 'ready', path: local.path })
      if (this.deps.now() - local.receipt.checkedAt >= RELEASE_CHECK_INTERVAL_MS) {
        void this.refreshInBackground(tool, selected, local)
      }
      return local.path
    }

    try {
      return await this.installLatest(tool, selected, local ?? undefined)
    } catch (error) {
      if (local && forceRefresh && (error as { releaseFetchFailed?: boolean }).releaseFetchFailed) {
        this.states.set(tool, { state: 'ready', path: local.path })
        return local.path
      }
      this.states.set(tool, { state: 'failed', message: errorMessage(error) })
      throw error
    }
  }

  private async refreshInBackground(
    tool: PortableMediaTool,
    selected: PortableToolAsset,
    local: { path: string; receipt: ReleaseReceipt },
  ): Promise<void> {
    try {
      await this.installLatest(tool, selected, local)
    } catch {
      this.states.set(tool, { state: 'ready', path: local.path })
    }
  }

  private async fetchLatest(repo: string): Promise<GitHubRelease> {
    try {
      return await this.deps.fetchRelease(repo)
    } catch (error) {
      if (error && typeof error === 'object') Object.assign(error, { releaseFetchFailed: true })
      throw error
    }
  }

  private async installLatest(
    tool: PortableMediaTool,
    selected: PortableToolAsset,
    local?: { path: string; receipt: ReleaseReceipt },
  ): Promise<string> {
    const release = await this.fetchLatest(selected.repo)
    const asset = release.assets.find((candidate) => candidate.name === selected.asset)
    if (!asset) throw new Error(`Release ${release.tag_name} no file ${selected.asset}`)
    if (!asset.digest || !SHA256_DIGEST.test(asset.digest)) {
      throw new Error(`GitHub not published sha256 digest for ${selected.asset}; a checksum is required`)
    }
    const files = this.paths(tool, selected)
    if (local && digestsEqual(local.receipt.digest, asset.digest)) {
      await this.writeReceipt(files.receipt, {
        tag: release.tag_name,
        asset: selected.asset,
        digest: asset.digest,
        checkedAt: this.deps.now(),
      })
      this.states.set(tool, { state: 'ready', path: local.path })
      return local.path
    }

    this.states.set(tool, { state: 'downloading', percent: 0 })
    await fs.mkdir(this.deps.toolsDir, { recursive: true })
    const part = `${files.target}.${process.pid}.part`
    const backup = `${files.target}.${process.pid}.old`
    try {
      const download = await this.deps.fetchAsset(asset.browser_download_url)
      if (!download.body) throw new Error(`GitHub returned empty file ${selected.asset}`)
      const total = download.size && download.size > 0 ? download.size : asset.size
      const hash = createHash('sha256')
      let received = 0
      const verifier = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          hash.update(chunk)
          received += chunk.length
          this.emitProgress(tool, received, total)
          callback(null, chunk)
        },
      })
      await pipeline(
        Readable.fromWeb(download.body as Parameters<typeof Readable.fromWeb>[0]),
        verifier,
        createWriteStream(part),
      )
      if (received === 0) throw new Error(`GitHub returned empty file ${selected.asset}`)
      const actualDigest = `sha256:${hash.digest('hex')}`
      if (!digestsEqual(actualDigest, asset.digest)) throw new Error(`Not matched checksum sum ${selected.asset}`)
      await fs.chmod(part, 0o755).catch(() => undefined)

      const hadTarget = await exists(files.target)
      if (hadTarget) await fs.rename(files.target, backup)
      try {
        await fs.rename(part, files.target)
        await this.writeReceipt(files.receipt, {
          tag: release.tag_name,
          asset: selected.asset,
          digest: asset.digest,
          checkedAt: this.deps.now(),
        })
      } catch (error) {
        await fs.rm(files.target, { force: true }).catch(() => undefined)
        if (hadTarget) await fs.rename(backup, files.target).catch(() => undefined)
        throw error
      }
      await fs.rm(backup, { force: true }).catch(() => undefined)
      this.states.set(tool, { state: 'ready', path: files.target })
      return files.target
    } catch (error) {
      await fs.rm(part, { force: true }).catch(() => undefined)
      await fs.rm(backup, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async writeReceipt(file: string, receipt: ReleaseReceipt): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(receipt, null, 2), 'utf8')
      await fs.rename(tmp, file)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
