import fs from 'node:fs/promises'
import path from 'node:path'
import { extractByBaseName } from './zipExtract.js'

/** Портативный ffmpeg: живёт в runtime/ рядом с приложением и переезжает
 *  вместе с папкой, как портативный Node и cloudflared. Ставить что-то в
 *  систему покупателю не нужно.
 *
 * Качаем ИМЕННО LGPL-сборку, и это не формальность. Обычные сборки (те же
 * «essentials» с gyan.dev) собраны с x264/x265 и потому целиком GPL —
 * положить такую в проданное приложение нельзя. LGPL-сборка умеет всё, что
 * нам нужно: резать и склеивать копированием потока (кодировщик там вообще
 * не участвует), доставать кадры и дорожки, искать склейки. Для кропа, где
 * пережать всё-таки придётся, в ней есть аппаратные кодировщики видеокарты —
 * NVENC, QSV и AMF лицензией GPL не заражены. */

const RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'

export interface FfmpegPlatform {
  /** Имя архива в релизах BtbN. null — сборку кладём в поставку, и качать её
   *  неоткуда: под macOS у BtbN сборок нет вовсе, а все публичные (evermeet,
   *  Homebrew) собраны с x264, то есть целиком GPL. Свою LGPL-сборку мы кладём
   *  прямо в папку приложения — см. scripts/build-ffmpeg-macos.sh. */
  asset: string | null
  /** Имена файлов, которые достаём из архива и кладём в runtime/. */
  binaries: { ffmpeg: string; ffprobe: string }
}

export function ffmpegPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): FfmpegPlatform | null {
  if (platform === 'win32' && arch !== 'arm64') {
    return {
      asset: 'ffmpeg-master-latest-win64-lgpl.zip',
      binaries: { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' },
    }
  }
  if (platform === 'linux') {
    return {
      asset: arch === 'arm64' ? 'ffmpeg-master-latest-linuxarm64-lgpl.tar.xz' : 'ffmpeg-master-latest-linux64-lgpl.tar.xz',
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    }
  }
  // ⚠️ macOS обязан быть ЗДЕСЬ, хотя качать нечего. Раньше он попадал в null
  // ниже, а `locate` на неизвестной платформе выходит ДО того, как заглянет в
  // runtime/ — то есть свою же сборку, лежащую в папке, приложение не видело.
  if (platform === 'darwin') {
    return { asset: null, binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } }
  }
  return null
}

export function ffmpegDownloadUrl(platform: FfmpegPlatform): string {
  if (!platform.asset) throw new Error('This system uses the ffmpeg build bundled with the app; it is not downloaded.')
  return `${RELEASE}/${platform.asset}`
}

export interface FfmpegTools {
  ffmpeg: string
  ffprobe: string
}

export type FfmpegBinaryState =
  | { state: 'ready'; tools: FfmpegTools; source: 'runtime' | 'system' }
  | { state: 'missing' }
  | { state: 'downloading'; percent: number }
  | { state: 'unsupported' }
  | { state: 'failed'; message: string }

export interface FfmpegBinaryDeps {
  runtimeDir: string
  /** Подменяется в тестах: настоящая закачка ходит в интернет. */
  fetchAsset?: (url: string) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; size: number | null }>
  platform?: () => FfmpegPlatform | null
  /** Системный ffmpeg, если он уже стоит у разработчика. */
  systemTools?: () => Promise<FfmpegTools | null>
}

export class FfmpegBinary {
  private readonly runtimeDir: string
  private readonly fetchAsset: NonNullable<FfmpegBinaryDeps['fetchAsset']>
  private readonly platform: NonNullable<FfmpegBinaryDeps['platform']>
  private readonly systemTools: NonNullable<FfmpegBinaryDeps['systemTools']>
  private state: FfmpegBinaryState = { state: 'missing' }
  private downloading: Promise<FfmpegTools> | null = null

  constructor(deps: FfmpegBinaryDeps) {
    this.runtimeDir = deps.runtimeDir
    this.platform = deps.platform ?? (() => ffmpegPlatform())
    this.systemTools = deps.systemTools ?? (async () => null)
    this.fetchAsset = deps.fetchAsset ?? (async (url) => {
      const response = await fetch(url, { redirect: 'follow' })
      const length = Number(response.headers.get('content-length'))
      return {
        ok: response.ok,
        status: response.status,
        body: response.body,
        size: Number.isFinite(length) && length > 0 ? length : null,
      }
    })
  }

  getState(): FfmpegBinaryState {
    return this.state
  }

  /** Готовые инструменты или null, если качать ещё не начинали. */
  async locate(): Promise<FfmpegTools | null> {
    const platform = this.platform()
    if (!platform) {
      this.state = { state: 'unsupported' }
      return null
    }
    const local: FfmpegTools = {
      ffmpeg: path.join(this.runtimeDir, platform.binaries.ffmpeg),
      ffprobe: path.join(this.runtimeDir, platform.binaries.ffprobe),
    }
    // Идущую закачку опрос состояния трогать не имеет права: на машине, где
    // ffmpeg уже стоит в системе, каждый опрос перебивал бы «качается 40%» на
    // «готов, системный» — и процент пропадал бы на глазах.
    const downloading = this.state.state === 'downloading'
    const remember = (next: FfmpegBinaryState) => {
      if (!downloading) this.state = next
    }

    // Нужны ОБА: без ffprobe не узнать ни длительности, ни опорных кадров,
    // и половина операций молча превратилась бы в догадки.
    const bothPresent = await Promise.all([
      fs.access(local.ffmpeg).then(() => true, () => false),
      fs.access(local.ffprobe).then(() => true, () => false),
    ])
    if (bothPresent[0] && bothPresent[1]) {
      remember({ state: 'ready', tools: local, source: 'runtime' })
      return local
    }
    const system = await this.systemTools()
    if (system) {
      remember({ state: 'ready', tools: system, source: 'system' })
      return system
    }
    remember({ state: 'missing' })
    return null
  }

  /** Скачать в runtime/. Повторный вызов во время закачки ждёт ту же. */
  download(): Promise<FfmpegTools> {
    if (this.downloading) return this.downloading
    const platform = this.platform()
    if (!platform) {
      this.state = { state: 'unsupported' }
      return Promise.reject(new Error('No bundled ffmpeg build is available for this system'))
    }
    if (!platform.asset) {
      // Не «система не поддержана»: ffmpeg тут работает, просто лежит в папке
      // с самого начала. Если его нет — это битая установка, а не «нажми скачать».
      this.state = { state: 'unsupported' }
      return Promise.reject(new Error('ffmpeg is bundled with the app; there is nowhere to download it from'))
    }
    if (!platform.asset.endsWith('.zip')) {
      // Linux отдаётся tar.xz; распаковку добавим, когда появится сборка под него.
      this.state = { state: 'unsupported' }
      return Promise.reject(new Error('Automatic ffmpeg download is not supported for this system yet'))
    }

    const url = ffmpegDownloadUrl(platform)
    this.state = { state: 'downloading', percent: 0 }

    this.downloading = (async () => {
      try {
        await fs.mkdir(this.runtimeDir, { recursive: true })
        const response = await this.fetchAsset(url)
        if (!response.ok || !response.body) {
          throw new Error(`Could not download ffmpeg (HTTP ${response.status})`)
        }

        const chunks: Buffer[] = []
        let received = 0
        for await (const chunk of streamChunks(response.body)) {
          chunks.push(chunk)
          received += chunk.length
          if (response.size) {
            // 99 — потолок закачки: распаковка тоже занимает время, и
            // показывать 100% там, где ещё ничего не готово, нечестно.
            this.state = { state: 'downloading', percent: Math.min(99, Math.round((received / response.size) * 100)) }
          }
        }

        const wanted = [platform.binaries.ffmpeg, platform.binaries.ffprobe]
        const found = extractByBaseName(Buffer.concat(chunks), wanted)
        for (const name of wanted) {
          if (!found.has(name.toLowerCase())) throw new Error(`Release archive has no file ${name}`)
        }

        // Пишем через .part и переименовываем: оборванная запись не должна
        // оставить в runtime/ файл, который при следующем старте сойдёт за готовый.
        const tools: FfmpegTools = {
          ffmpeg: path.join(this.runtimeDir, platform.binaries.ffmpeg),
          ffprobe: path.join(this.runtimeDir, platform.binaries.ffprobe),
        }
        for (const name of wanted) {
          const target = path.join(this.runtimeDir, name)
          const temporary = `${target}.part`
          await fs.writeFile(temporary, found.get(name.toLowerCase())!)
          await fs.rename(temporary, target)
          await fs.chmod(target, 0o755).catch(() => undefined)
        }

        this.state = { state: 'ready', tools, source: 'runtime' }
        return tools
      } catch (error) {
        this.state = { state: 'failed', message: error instanceof Error ? error.message : 'Could not download ffmpeg' }
        throw error
      } finally {
        this.downloading = null
      }
    })()

    return this.downloading
  }
}

async function* streamChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield Buffer.from(value)
    }
  } finally {
    reader.releaseLock()
  }
}
