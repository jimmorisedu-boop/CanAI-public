import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolError } from '../ffmpegRun.js'
import type { AgentArtifact, AgentArtifactRef, AgentMediaRenderManifest } from '../../../packages/agent-protocol/index.js'
import type { MediaRenderRun } from './tool-shared.js'
import type { AgentTaskRecord } from './types.js'

// Оснастка тестов чернового монтажа: подставные ffmpeg и ffprobe.
//
// Подставной файл — настоящая сигнатура формата плюс строка с описанием
// («FAKE:{…}»). Подставной ffprobe читает описание из файла, подставной ffmpeg
// пишет результат с описанием, собранным из СВОЕЙ командной строки. Поэтому
// тест проверяет ровно то, что Host передал бы настоящему ffmpeg.

export const FAKE_TOOLS = { ffmpeg: 'fake-ffmpeg', ffprobe: 'fake-ffprobe' }

export interface FakeMedia {
  width: number
  height: number
  fps?: number
  duration?: number
  frames?: number
  codec?: string
  pixFmt?: string
  audio?: boolean
  formatName?: string
}

const HEADERS: Record<string, Buffer> = {
  'video/mp4': Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom\0\0\x02\0isomiso2', 'latin1')]),
  'video/quicktime': Buffer.concat([Buffer.from([0, 0, 0, 0x08]), Buffer.from('wide\0\0\0\0mdat', 'latin1')]),
  'video/webm': Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  'image/webp': Buffer.concat([Buffer.from('RIFF\x20\0\0\0WEBPVP8 ', 'latin1')]),
  'image/gif': Buffer.from('GIF89a', 'latin1'),
  'audio/mpeg': Buffer.from('ID3\x03\0\0', 'latin1'),
}

const EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'text/plain': 'txt',
}

const FORMAT_NAMES: Record<string, string> = {
  '.mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  '.mov': 'mov,mp4,m4a,3gp,3g2,mj2',
  '.webm': 'matroska,webm',
  '.png': 'png_pipe',
  '.jpg': 'image2',
  '.webp': 'webp_pipe',
}

export function fakeBytes(mimeType: string, meta: FakeMedia, options: { prefix?: Buffer; size?: number } = {}): Buffer {
  const body = Buffer.concat([options.prefix ?? HEADERS[mimeType] ?? Buffer.alloc(0), Buffer.from(`\nFAKE:${JSON.stringify(meta)}\n`, 'utf8')])
  return options.size && options.size > body.length ? Buffer.concat([body, Buffer.alloc(options.size - body.length, 0x2e)]) : body
}

async function readFake(file: string): Promise<FakeMedia | null> {
  const text = (await fs.readFile(file)).subarray(0, 4096).toString('latin1')
  const match = /FAKE:(\{.*?\})\n/u.exec(text)
  return match ? JSON.parse(match[1]) as FakeMedia : null
}

function probeJson(file: string, meta: FakeMedia): string {
  const duration = meta.duration ?? (meta.frames && meta.fps ? meta.frames / meta.fps : undefined)
  return JSON.stringify({
    streams: [
      {
        codec_type: 'video', codec_name: meta.codec ?? 'h264', pix_fmt: meta.pixFmt ?? 'yuv420p', width: meta.width, height: meta.height,
        r_frame_rate: `${meta.fps ?? 25}/1`,
        ...(meta.frames !== undefined ? { nb_frames: String(meta.frames) } : {}),
        ...(duration !== undefined ? { duration: duration.toFixed(6) } : {}),
      },
      ...(meta.audio ? [{ codec_type: 'audio', codec_name: 'aac' }] : []),
    ],
    format: {
      format_name: meta.formatName ?? FORMAT_NAMES[path.extname(file).toLowerCase()] ?? 'unknown',
      ...(duration !== undefined ? { duration: duration.toFixed(6) } : {}),
    },
  })
}

export interface RenderCall {
  args: string[]
  encoder: string
  output: string
  signal: AbortSignal | undefined
  timeoutMs: number | undefined
  /** Что ffmpeg собрал бы по этой командной строке. */
  meta: Required<Pick<FakeMedia, 'width' | 'height' | 'fps' | 'frames'>>
  /** Записать результат; можно подменить описание и размер файла. */
  write(override?: Partial<FakeMedia> & { bytes?: number }): Promise<void>
}

export interface FakeRunnerOptions {
  /** Что «значится в сборке» по `ffmpeg -encoders`. */
  encoders?: string[]
  /** Поведение рендера. По умолчанию — честно записать результат. */
  render?: (call: RenderCall) => Promise<void>
}

export function fakeRunner(options: FakeRunnerOptions = {}) {
  const calls: Array<{ kind: 'encoders' | 'probe' | 'render'; args: string[] }> = []
  let active = 0
  let peak = 0
  const run: MediaRenderRun = async (executable, args, runOptions) => {
    const list = [...args]
    if (executable === FAKE_TOOLS.ffmpeg && list.includes('-encoders')) {
      calls.push({ kind: 'encoders', args: list })
      const listing = (options.encoders ?? ['libopenh264']).map((name) => ` V....D ${name.padEnd(20)} test encoder`).join('\n')
      return { stdout: Buffer.from(`Encoders:\n ------\n${listing}\n`, 'utf8'), stderr: '' }
    }
    if (executable === FAKE_TOOLS.ffprobe) {
      calls.push({ kind: 'probe', args: list })
      const file = list.at(-1)!
      const meta = await readFake(file)
      if (!meta) throw new ToolError('Handler exited with error (1)', `${file}: Invalid data found when processing input`)
      return { stdout: Buffer.from(probeJson(file, meta), 'utf8'), stderr: '' }
    }
    calls.push({ kind: 'render', args: list })
    active += 1
    peak = Math.max(peak, active)
    try {
      const filter = list[list.indexOf('-filter_complex') + 1] ?? ''
      const scale = /scale=(\d+):(\d+)/u.exec(filter)
      const meta = {
        width: Number(scale?.[1]),
        height: Number(scale?.[2]),
        fps: Number(/fps=(\d+)/u.exec(filter)?.[1]),
        frames: [...filter.matchAll(/trim=end_frame=(\d+)/gu)].reduce((sum, match) => sum + Number(match[1]), 0),
      }
      const output = list.at(-1)!
      const call: RenderCall = {
        args: list,
        encoder: list[list.indexOf('-c:v') + 1],
        output,
        signal: runOptions?.signal,
        timeoutMs: runOptions?.timeoutMs,
        meta,
        write: async (override = {}) => {
          const { bytes, ...rest } = override
          await fs.writeFile(output, fakeBytes('video/mp4', { ...meta, codec: 'h264', pixFmt: 'yuv420p', ...rest }, { size: bytes ?? 70_000 }))
        },
      }
      if (options.render) await options.render(call)
      else await call.write()
      return { stdout: Buffer.alloc(0), stderr: '' }
    } finally {
      active -= 1
    }
  }
  return {
    run,
    calls,
    renders: () => calls.filter((call) => call.kind === 'render'),
    probes: () => calls.filter((call) => call.kind === 'probe'),
    peak: () => peak,
  }
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export function refOf(artifact: AgentArtifactRef): AgentArtifactRef {
  return { artifactId: artifact.artifactId, revision: artifact.revision, checksum: artifact.checksum }
}

export function codeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined
}

export interface RenderFixture {
  root: string
  mediaDir: string
  workspace: string
  task: AgentTaskRecord
  /** Положить файл в медиа и выдать на него квитанцию задачи. */
  add(name: string, kind: AgentArtifact['kind'], mimeType: string, bytes: Buffer, provenance?: AgentArtifact['provenance']): Promise<AgentArtifact>
  cleanup(): Promise<void>
}

export async function renderFixture(prefix = 'canai-media-render-'): Promise<RenderFixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  const mediaDir = path.join(root, 'media')
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(mediaDir, { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  const suffix = path.basename(root).slice(-8).replace(/[^A-Za-z0-9]/gu, 'x')
  const task: AgentTaskRecord = {
    taskId: `agent-task-render-${suffix}`, requestId: `request-${suffix}`, requestHash: 'hash', packageId: 'canai.test', packageVersion: '1.0.0', packageSha: 'sha', protocolVersion: '1.0',
    projectRef: { source: 'local', id: 'render-board' }, ownerId: 'owner', controllerId: 'controller', taskType: 'render-test', instruction: 'Render', input: {},
    inputs: [], workspaceId: `workspace-${suffix}`, workspacePath: workspace, state: 'running', revision: 1, eventCursor: 0,
    currentMessageAcks: {}, operationIntents: {}, controlReceipts: {}, decisionReceipts: {}, receipts: [], reviews: [], decisions: [], artifacts: [],
    mediaRenderOperations: [], canvasItems: [], pendingCanvasItems: [], createdAt: 1, updatedAt: 1,
  }
  return {
    root, mediaDir, workspace, task,
    async add(name, kind, mimeType, bytes, provenance = 'generated') {
      const fileName = `${name}-${suffix}.${EXTENSIONS[mimeType] ?? 'bin'}`
      await fs.writeFile(path.join(mediaDir, fileName), bytes)
      const artifact: AgentArtifact = {
        artifactId: `${name}-${suffix}`, revision: 1, checksum: sha256(bytes), kind, caption: name, mimeType, sizeBytes: bytes.length,
        mediaSrc: `/media/${fileName}`, provenance,
      }
      task.artifacts.push(artifact)
      return artifact
    },
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => undefined)
    },
  }
}

export function manifestOf(
  clips: Array<{ artifact: AgentArtifactRef; startMs?: number; durationMs: number }>,
  overrides: Partial<AgentMediaRenderManifest> = {},
): AgentMediaRenderManifest {
  return {
    version: 1,
    mode: 'rough-cut',
    audio: 'mute',
    clips: clips.map((clip, index) => ({ artifact: refOf(clip.artifact), order: index, startMs: clip.startMs ?? 0, durationMs: clip.durationMs })),
    fps: 24,
    maxDurationMs: 60_000,
    maxOutputBytes: 8 * 1024 * 1024,
    ...overrides,
  }
}

/** Аргументы, стоящие перед каждым `-i`: [ограничения и параметры входа, файл]. */
export function inputSections(args: readonly string[]): Array<{ options: string[]; file: string }> {
  const sections: Array<{ options: string[]; file: string }> = []
  let from = 4 // «-v error -nostdin -y»
  args.forEach((arg, index) => {
    if (arg !== '-i') return
    sections.push({ options: args.slice(from, index), file: args[index + 1] })
    from = index + 2
  })
  return sections
}
