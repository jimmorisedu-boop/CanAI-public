import crypto from 'node:crypto'
import { AgentPackageError } from './package-errors.js'
import type { ArchiveProvenance } from './package-upload.js'

const SHA_RE = /^[0-9a-f]{40}$/
const OWNER_RE = /^[A-Za-z0-9_.-]{1,100}$/
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024

export interface GitPackageSource {
  kind: 'git'
  url: string
  ref?: string
  subdir?: string
}

/** A locally uploaded archive has no fake Git URL or commit identity. */
export interface ArchivePackageSource {
  kind: 'archive'
  archiveId: string
  subdir?: string
  provenance?: ArchiveProvenance
}

export interface ResolvedArchiveSource {
  kind: 'archive'
  archiveId: string
  archiveSha: string
  subdir?: string
  provenance?: ArchiveProvenance
}

export interface ResolvedGitSource {
  kind: 'git'
  canonicalUrl: string
  requestedRef: string
  resolvedSha: string
  subdir?: string
  archiveUrl: string
}

export interface GitSourceTransport {
  resolve(source: GitPackageSource): Promise<ResolvedGitSource>
  download(source: ResolvedGitSource): Promise<Buffer>
}

export function canonicalGitSource(source: GitPackageSource): { kind: 'git'; canonicalUrl: string; owner: string; repo: string; ref: string; subdir?: string } {
  if (!source || source.kind !== 'git' || typeof source.url !== 'string') {
    throw new AgentPackageError('SOURCE_UNSUPPORTED', 'Only a public GitHub HTTPS source is supported')
  }
  let parsed: URL
  try { parsed = new URL(source.url) } catch { throw new AgentPackageError('SOURCE_INVALID', 'Source URL is invalid') }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || /%2f|%5c/i.test(parsed.pathname)) {
    throw new AgentPackageError('SOURCE_UNSUPPORTED', 'Only a public GitHub HTTPS URL without credentials is allowed')
  }
  const pieces = parsed.pathname.split('/').filter(Boolean)
  if (pieces.length !== 2) throw new AgentPackageError('SOURCE_INVALID', 'GitHub URL must have the form /owner/repository')
  const owner = pieces[0].toLowerCase()
  const repo = pieces[1].replace(/\.git$/i, '').toLowerCase()
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) throw new AgentPackageError('SOURCE_INVALID', 'GitHub repository name is invalid')
  const ref = typeof source.ref === 'string' && source.ref.trim() ? source.ref.trim() : 'HEAD'
  if (ref.length > 256 || /[\u0000\r\n]/.test(ref)) throw new AgentPackageError('SOURCE_INVALID', 'Source ref is invalid')
  const subdir = normalizeSubdir(source.subdir)
  return {
    kind: 'git',
    canonicalUrl: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`,
    owner,
    repo,
    ref,
    ...(subdir ? { subdir } : {}),
  }
}

function normalizeSubdir(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 240 || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new AgentPackageError('SOURCE_INVALID', 'subdir must be a relative POSIX path')
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new AgentPackageError('SOURCE_INVALID', 'subdir contains an invalid segment')
  return parts.join('/')
}

function sha256(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex') }

function githubApiUrl(owner: string, repo: string, path: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`
}

function allowedArchiveUrl(value: string, source: ResolvedGitSource): boolean {
  if (!SHA_RE.test(source.resolvedSha)) return false
  const sourceMatch = /^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/u.exec(source.canonicalUrl)
  if (!sourceMatch) return false
  const owner = sourceMatch[1]
  const repo = sourceMatch[2]
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return false
    const path = parsed.pathname
    return (parsed.hostname.toLowerCase() === 'api.github.com' && path === `/repos/${owner}/${repo}/zipball/${source.resolvedSha}`)
      || (parsed.hostname.toLowerCase() === 'codeload.github.com' && path === `/${owner}/${repo}/legacy.zip/${source.resolvedSha}`)
  } catch { return false }
}

async function boundedResponse(response: Response, maxBytes: number, errorCode: string, signal?: AbortSignal): Promise<Buffer> {
  if (!response.ok) throw new AgentPackageError(errorCode, `GitHub returned HTTP ${response.status}`, response.status >= 500 ? 502 : 400)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new AgentPackageError('ARCHIVE_TOO_LARGE', 'Package archive exceeds the allowed size', 413)
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > maxBytes) throw new AgentPackageError('ARCHIVE_TOO_LARGE', 'Package archive exceeds the allowed size', 413)
    return body
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  const readBody = async () => {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.length
      if (total > maxBytes) throw new AgentPackageError('ARCHIVE_TOO_LARGE', 'Package archive exceeds the allowed size', 413)
      chunks.push(chunk)
    }
  }
  const abort = signal ? new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new AgentPackageError('GIT_TIMEOUT', 'GitHub request timed out', 504))
    else signal.addEventListener('abort', () => reject(new AgentPackageError('GIT_TIMEOUT', 'GitHub request timed out', 504)), { once: true })
  }) : null
  try { await (abort ? Promise.race([readBody(), abort]) : readBody()) }
  finally { await reader.cancel().catch(() => undefined) }
  return Buffer.concat(chunks)
}

export interface GitHubSourceOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class GitHubSourceTransport implements GitSourceTransport {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: GitHubSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000))
  }

  async resolve(source: GitPackageSource): Promise<ResolvedGitSource> {
    const normalized = canonicalGitSource(source)
    const metadata = await this.getJson(githubApiUrl(normalized.owner, normalized.repo, ''))
    if (metadata.private === true) throw new AgentPackageError('SOURCE_PRIVATE', 'Private GitHub repositories are not supported')
    const requestedRef = normalized.ref === 'HEAD'
      ? (typeof metadata.default_branch === 'string' && metadata.default_branch ? metadata.default_branch : 'HEAD')
      : normalized.ref
    const commit = await this.getJson(githubApiUrl(normalized.owner, normalized.repo, `/commits/${encodeURIComponent(requestedRef)}`))
    const resolvedSha = typeof commit.sha === 'string' ? commit.sha.toLowerCase() : ''
    if (!SHA_RE.test(resolvedSha)) throw new AgentPackageError('GIT_SHA_INVALID', 'GitHub did not return a full 40-character SHA')
    return {
      kind: 'git', canonicalUrl: normalized.canonicalUrl, requestedRef,
      resolvedSha, ...(normalized.subdir ? { subdir: normalized.subdir } : {}),
      archiveUrl: githubApiUrl(normalized.owner, normalized.repo, `/zipball/${resolvedSha}`),
    }
  }

  async download(source: ResolvedGitSource): Promise<Buffer> {
    if (!allowedArchiveUrl(source.archiveUrl, source)) throw new AgentPackageError('GIT_ARCHIVE_URL_UNSAFE', 'GitHub archive URL is not on the allowlist')
    let url = source.archiveUrl
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await this.fetchBytes(url, { redirect: 'manual', headers: { accept: 'application/zip', 'user-agent': 'CanAI-agent-installer/1' } }, MAX_ARCHIVE_BYTES, 'GIT_ARCHIVE_FAILED')
      if (response.status >= 300 && response.status < 400) {
        const next = response.location
        if (!next || !allowedArchiveUrl(next, source)) throw new AgentPackageError('GIT_REDIRECT_UNSAFE', 'GitHub archive redirect is forbidden')
        url = next
        continue
      }
      if (!response.body) throw new AgentPackageError('GIT_ARCHIVE_FAILED', 'GitHub archive is empty')
      return response.body
    }
    throw new AgentPackageError('GIT_REDIRECT_LIMIT', 'Too many redirects while downloading the GitHub archive')
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const response = await this.fetchBytes(url, { redirect: 'error', headers: { accept: 'application/vnd.github+json', 'user-agent': 'CanAI-agent-installer/1' } }, 1024 * 1024, 'GIT_RESOLVE_FAILED')
    if (!response.body) throw new AgentPackageError('GIT_RESOLVE_FAILED', 'GitHub returned an empty response')
    let body: unknown
    try { body = JSON.parse(response.body.toString('utf8')) as unknown }
    catch { throw new AgentPackageError('GIT_RESOLVE_FAILED', 'GitHub returned invalid JSON') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentPackageError('GIT_RESOLVE_FAILED', 'GitHub returned an invalid response')
    return body as Record<string, unknown>
  }

  private async fetchBytes(url: string, init: RequestInit, maxBytes: number, errorCode: string): Promise<{ status: number; location: string | null; body: Buffer | null }> {
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, { ...init, signal: timer.signal })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        return { status: response.status, location: response.headers.get('location'), body: null }
      }
      return { status: response.status, location: null, body: await boundedResponse(response, maxBytes, errorCode, timer.signal) }
    } catch (error) {
      if (timer.signal.aborted) throw new AgentPackageError('GIT_TIMEOUT', 'GitHub request timed out', 504)
      if (error instanceof AgentPackageError) throw error
      throw new AgentPackageError('GIT_NETWORK_FAILED', 'GitHub request failed', 502)
    } finally { clearTimeout(timeout) }
  }
}

export function packageSourceKey(source: ResolvedGitSource): string {
  return `${source.canonicalUrl}@${source.resolvedSha}${source.subdir ? `#${source.subdir}` : ''}`
}

export function isFullSha(value: string): boolean { return SHA_RE.test(value) }

export function archiveChecksum(archive: Buffer): string { return sha256(archive) }
