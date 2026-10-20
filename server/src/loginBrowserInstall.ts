import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Портативный браузер для входа на площадки.
 *
 * Зачем: вход нужен там, где видео отдают только своим (сейчас Vimeo), а взять
 * cookies можно только из Firefox — Chromium на Windows их шифрует (см.
 * `loginBrowser.ts`). У покупателя Firefox может не стоять вовсе, поэтому его
 * надо уметь доставить.
 *
 * ⚠️ В ПОСТАВКУ Firefox не кладём, и это не лень:
 *   • распакованный он весит 352 МБ (замерено) — вчетверо больше всего
 *     остального приложения, ради функции, которая нужна единицам;
 *   • правило Mozilla разрешает распространять его только САМОЙ СВЕЖЕЙ версии,
 *     а выходит он примерно раз в месяц: коробка с Firefox внутри протухает
 *     между нашими выпусками, и это браузер, в котором человек вводит пароль;
 *   • качая с серверов Mozilla по нажатию человека, мы не распространяем его
 *     вовсе — ровно как ffmpeg и yt-dlp.
 *
 * ⚠️ Установщик РАСПАКОВЫВАЕМ, а не устанавливаем: `/ExtractDir=` кладёт файлы
 * в указанную папку и не трогает ни реестр, ни ярлыки, ни систему (проверено
 * 18.09.2026 — после распаковки не осталось ни процесса, ни записей). Портативность
 * тут такой же инвариант, как у всего остального в runtime/.
 */

const DOWNLOAD_URL = 'https://download.mozilla.org/?product=firefox-latest-ssl&os=win64&lang=en-US'
const EXTRACT_TIMEOUT_MS = 10 * 60_000

export type LoginBrowserInstallState =
  | { state: 'ready'; executable: string; source: 'runtime' | 'system' }
  | { state: 'missing' }
  | { state: 'downloading'; percent: number }
  /** Качать неоткуда: на маке Firefox ставится перетаскиванием, и найдём мы его сами. */
  | { state: 'unsupported' }
  | { state: 'failed'; message: string }

export interface LoginBrowserInstallDeps {
  runtimeDir: string
  /** Подменяется в тестах: настоящая закачка ходит в интернет. */
  fetchAsset?: (url: string) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; size: number | null }>
  /** Распаковка установщика. В тестах подменяется — запускать exe там нечем. */
  extract?: (installer: string, target: string) => Promise<void>
  platform?: NodeJS.Platform
  /** Уже установленный в системе Firefox, если он есть. */
  systemExecutable?: () => Promise<string | null>
}

function runExtract(installer: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // ⚠️ Именно /ExtractDir: запуск без него открыл бы окно установщика на
    // экране человека и поставил бы Firefox в систему.
    const child = spawn(installer, [`/ExtractDir=${target}`], { windowsHide: true, stdio: 'ignore' })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => finish(
      code === 0 ? undefined : new Error(`Firefox installer exited with code ${code ?? 'unknown'}`),
    ))
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('Firefox installer did not respond in time'))
    }, EXTRACT_TIMEOUT_MS)
    timer.unref()
  })
}

export class LoginBrowserInstall {
  private readonly runtimeDir: string
  private readonly fetchAsset: NonNullable<LoginBrowserInstallDeps['fetchAsset']>
  private readonly extract: NonNullable<LoginBrowserInstallDeps['extract']>
  private readonly platform: NodeJS.Platform
  private readonly systemExecutable: NonNullable<LoginBrowserInstallDeps['systemExecutable']>
  private state: LoginBrowserInstallState = { state: 'missing' }
  private downloading: Promise<string> | null = null

  constructor(deps: LoginBrowserInstallDeps) {
    this.runtimeDir = deps.runtimeDir
    this.platform = deps.platform ?? process.platform
    this.extract = deps.extract ?? runExtract
    this.systemExecutable = deps.systemExecutable ?? (async () => null)
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

  /** Куда распаковываем и что потом запускаем. */
  get executable(): string {
    return path.join(this.runtimeDir, 'core', 'firefox.exe')
  }

  getState(): LoginBrowserInstallState {
    return this.state
  }

  /** Своя копия или системная; null — качать ещё не начинали. */
  async locate(): Promise<string | null> {
    const downloading = this.state.state === 'downloading'
    const remember = (next: LoginBrowserInstallState) => {
      // Идущую закачку опрос состояния перебивать не имеет права — та же
      // грабля, что у ffmpeg: иначе «качается 40%» сменялось бы на «нет».
      if (!downloading) this.state = next
    }
    if (await fs.access(this.executable).then(() => true, () => false)) {
      remember({ state: 'ready', executable: this.executable, source: 'runtime' })
      return this.executable
    }
    const system = await this.systemExecutable()
    if (system) {
      remember({ state: 'ready', executable: system, source: 'system' })
      return system
    }
    // На маке и линуксе качать нечего: там Firefox ставится обычным способом,
    // а найдём мы его сами — говорить «скачать» про кнопку, которой нет, нельзя.
    remember(this.platform === 'win32' ? { state: 'missing' } : { state: 'unsupported' })
    return null
  }

  async prepare(): Promise<string> {
    if (this.downloading) return this.downloading
    const existing = await this.locate()
    if (existing) return existing
    if (this.platform !== 'win32') {
      this.state = { state: 'unsupported' }
      throw new Error('Firefox is installed normally on this system; the app finds it automatically')
    }

    this.state = { state: 'downloading', percent: 0 }
    this.downloading = (async () => {
      const installer = path.join(this.runtimeDir, 'firefox-setup.exe.part')
      try {
        await fs.mkdir(this.runtimeDir, { recursive: true })
        const response = await this.fetchAsset(DOWNLOAD_URL)
        if (!response.ok || !response.body) {
          throw new Error(`Could not download Firefox (HTTP ${response.status})`)
        }
        // ⚠️ Пишем ПОТОКОМ на диск, а не в память: установщик весит 93 МБ, и
        // держать его в куче сервера незачем (то же правило, что у загрузки медиа).
        let received = 0
        const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
        source.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (response.size) {
            // Потолок 95: распаковка 352 МБ тоже занимает время, и показывать
            // 100% там, где ещё ничего не готово, нечестно.
            this.state = { state: 'downloading', percent: Math.min(95, Math.round((received / response.size) * 95)) }
          }
        })
        await pipeline(source, createWriteStream(installer))

        this.state = { state: 'downloading', percent: 96 }
        await this.extract(installer, this.runtimeDir)
        if (!(await fs.access(this.executable).then(() => true, () => false))) {
          throw new Error('Firefox installer did not contain firefox.exe')
        }
        // Установщик больше не нужен — это ещё 93 МБ в папке приложения.
        await fs.rm(installer, { force: true }).catch(() => undefined)
        // ⚠️ И свою копию он кладёт внутрь распакованного (`setup.exe`).
        // Оставлять её нельзя не ради чистоты: двойной клик по ней ставит
        // Firefox в СИСТЕМУ, а мы весь этот путь затевали ради портативности.
        await fs.rm(path.join(this.runtimeDir, 'setup.exe'), { force: true }).catch(() => undefined)
        this.state = { state: 'ready', executable: this.executable, source: 'runtime' }
        return this.executable
      } catch (error) {
        await fs.rm(installer, { force: true }).catch(() => undefined)
        this.state = { state: 'failed', message: error instanceof Error ? error.message : 'Could not download Firefox' }
        throw error
      } finally {
        this.downloading = null
      }
    })()
    return this.downloading
  }
}
