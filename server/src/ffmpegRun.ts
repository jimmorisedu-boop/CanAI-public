import { spawn } from 'node:child_process'

// Запуск ffmpeg/ffprobe. Общий для всех операций над видео, поэтому здесь же
// всё, без чего внешний процесс однажды подвесит приложение: таймаут, предел
// на объём вывода и внятная ошибка вместо кода возврата.

export interface RunToolOptions {
  timeoutMs?: number
  /** Предел на stdout. Сырой PCM даже короткого клипа — мегабайты, и
   *  безлимитная буферизация означала бы «сколько отдаст, столько и съедим». */
  maxStdoutBytes?: number
  /** Отмена снаружи: процесс убивается сразу, а не доживает до таймаута.
   *  Нужна долгим операциям, которые человек вправе снять (рендер агента). */
  signal?: AbortSignal
}

export interface ToolResult {
  stdout: Buffer
  stderr: string
}

/** Почему процесс прервали мы сами. По тексту ошибки это не различить: текст
 *  русский, для человека, и однажды поменяется. */
export type ToolErrorReason = 'timeout' | 'aborted' | 'stdout'

export class ToolError extends Error {
  readonly stderr: string
  readonly reason?: ToolErrorReason

  constructor(message: string, stderr: string, reason?: ToolErrorReason) {
    super(message)
    this.stderr = stderr
    this.reason = reason
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_STDOUT = 256 * 1024 * 1024
const MAX_STDERR_CHARS = 8_192

export function runTool(
  executable: string,
  args: readonly string[],
  options: RunToolOptions = {},
): Promise<ToolResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT
  const signal = options.signal

  return new Promise((resolve, reject) => {
    // Отменили ещё до запуска — процесс не создаём вовсе.
    if (signal?.aborted) {
      reject(new ToolError('Processing cancelled', '', 'aborted'))
      return
    }

    const child = spawn(executable, [...args], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const chunks: Buffer[] = []
    let received = 0
    let stderr = ''
    let settled = false

    const finish = (error: Error | null, result?: ToolResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result!)
    }

    const onAbort = () => {
      child.kill('SIGKILL')
      finish(new ToolError('Processing cancelled', stderr, 'aborted'))
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new ToolError('Processing took too long and was interrupted', stderr, 'timeout'))
    }, timeoutMs)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxStdout) {
        child.kill('SIGKILL')
        finish(new ToolError('The processor returned too much data', stderr, 'stdout'))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // ffmpeg пишет в stderr весь свой лог; храним только хвост, он и нужен
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8')
    })

    child.once('error', (error) => finish(new ToolError(`Could not run processor: ${error.message}`, stderr)))
    child.once('close', (code) => {
      if (code === 0) finish(null, { stdout: Buffer.concat(chunks), stderr })
      else finish(new ToolError(`Handler exited with error (${code ?? 'unknown'})`, stderr))
    })
  })
}
