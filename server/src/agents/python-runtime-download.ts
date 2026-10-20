import { AgentPackageError } from './package-errors.js'
import {
  MAX_RUNTIME_ARCHIVE_BYTES,
  PORTABLE_PYTHON_ARCHIVE_SHA256,
  PORTABLE_PYTHON_ARCHIVE_URL,
  sha256,
} from './python-runtime-files.js'

export interface PythonArchiveDownloadOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  archiveUrl?: string
  /** Test transport injection. Production callers use the pinned default. */
  archiveSha256?: string
}

function validateArchiveSource(options: PythonArchiveDownloadOptions): { url: string; sha: string } {
  const url = options.archiveUrl ?? PORTABLE_PYTHON_ARCHIVE_URL
  if (url !== PORTABLE_PYTHON_ARCHIVE_URL) throw new AgentPackageError('RUNTIME_SOURCE_UNSUPPORTED', 'Only the official Python embeddable URL is allowed', 422)
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.python.org' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) throw new AgentPackageError('RUNTIME_SOURCE_UNSUPPORTED', 'Python runtime source must be the exact HTTPS URL on python.org', 422)
  const sha = options.archiveSha256 ?? PORTABLE_PYTHON_ARCHIVE_SHA256
  if (!/^[a-f0-9]{64}$/u.test(sha)) throw new AgentPackageError('RUNTIME_SOURCE_UNSUPPORTED', 'SHA-256 archive is required', 422)
  return { url, sha }
}

export async function downloadPythonRuntimeArchive(options: PythonArchiveDownloadOptions): Promise<{ bytes: Buffer; archiveSha: string }> {
  const { url: expectedUrl, sha: expectedSha } = validateArchiveSource(options)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 120_000))
  let timedOut = false
  let timeoutReject: ((error: AgentPackageError) => void) | undefined
  const timeoutPromise = new Promise<never>((_, reject) => { timeoutReject = reject })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    timeoutReject?.(new AgentPackageError('RUNTIME_DOWNLOAD_TIMEOUT', 'Python runtime download timed out', 504))
  }, timeoutMs)
  try {
    let url = expectedUrl
    for (let redirect = 0; redirect <= 2; redirect += 1) {
      const response = await Promise.race([
        fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/zip', 'user-agent': 'CanAI-python-runtime/1' } }),
        timeoutPromise,
      ])
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get('location')
        if (!next) throw new AgentPackageError('RUNTIME_REDIRECT_UNSAFE', 'Python runtime redirect is missing', 502)
        const nextUrl = new URL(next, url)
        if (nextUrl.protocol !== 'https:' || nextUrl.hostname !== 'www.python.org' || nextUrl.port || nextUrl.username || nextUrl.password || nextUrl.search || nextUrl.hash) throw new AgentPackageError('RUNTIME_REDIRECT_UNSAFE', 'Python runtime redirect leaves the exact origin', 502)
        url = nextUrl.toString()
        continue
      }
      if (!response.ok || !response.body) throw new AgentPackageError('RUNTIME_DOWNLOAD_FAILED', `Python runtime returned HTTP ${response.status}`, 502)
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RUNTIME_ARCHIVE_BYTES)) throw new AgentPackageError('RUNTIME_ARCHIVE_TOO_LARGE', 'Python runtime archive exceeds the limit', 413)
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let total = 0
      try {
        while (true) {
          const item = await Promise.race([reader.read(), timeoutPromise])
          if (item.done) break
          const chunk = Buffer.from(item.value)
          total += chunk.length
          if (total > MAX_RUNTIME_ARCHIVE_BYTES) throw new AgentPackageError('RUNTIME_ARCHIVE_TOO_LARGE', 'Python runtime archive exceeds the limit', 413)
          chunks.push(chunk)
        }
      } catch (error) {
        void reader.cancel().catch(() => undefined)
        throw error
      }
      const bytes = Buffer.concat(chunks)
      const archiveSha = sha256(bytes)
      if (archiveSha !== expectedSha) throw new AgentPackageError('RUNTIME_ARCHIVE_TAMPERED', 'Python runtime archive SHA-256 does not match', 409)
      return { bytes, archiveSha }
    }
    throw new AgentPackageError('RUNTIME_REDIRECT_LIMIT', 'Too many redirects for Python runtime', 502)
  } catch (error) {
    if (timedOut || controller.signal.aborted) throw new AgentPackageError('RUNTIME_DOWNLOAD_TIMEOUT', 'Python runtime download timed out', 504)
    if (error instanceof AgentPackageError) throw error
    throw new AgentPackageError('RUNTIME_DOWNLOAD_FAILED', 'Python runtime download failed', 502)
  } finally {
    clearTimeout(timer)
  }
}
