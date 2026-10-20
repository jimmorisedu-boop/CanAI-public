import fs from 'node:fs/promises'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Модели для сравнения лиц: живут в runtime/ рядом с портативным Node,
 *  ffmpeg и cloudflared, переезжают вместе с папкой и качаются кнопкой.
 *
 * ⚠️ Лицензия здесь не формальность, а условие: приложение продаётся.
 * Популярные ArcFace/InsightFace, которые первыми выдаёт поиск, отдают веса
 * ТОЛЬКО для некоммерческих исследований — класть их нельзя, ровно как нельзя
 * было брать GPL-сборку ffmpeg. Поэтому берём из OpenCV Zoo: YuNet (детектор,
 * MIT) и SFace (сравнение, Apache 2.0). Проверено по репозиторию 19.08.2026.
 *
 * Считает сходство КЛИЕНТ (onnxruntime-web), сервер только хранит файлы и
 * отдаёт их браузеру: движок в комплекте весит 13 МБ, а модели 38 МБ качает
 * тот, кому функция нужна. */

const LFS = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models'

export interface FaceModelSpec {
  /** Имя файла в runtime/face-models и в адресе для браузера. */
  name: string
  url: string
  /** Ожидаемый размер: файл меньше — значит вместо модели прилетела ошибка
   *  или указатель git-lfs, а не сама модель. */
  minBytes: number
  license: string
}

export const FACE_MODELS: FaceModelSpec[] = [
  {
    name: 'face_detection_yunet_2023mar.onnx',
    url: `${LFS}/face_detection_yunet/face_detection_yunet_2023mar.onnx`,
    minBytes: 200_000,
    license: 'MIT',
  },
  {
    name: 'face_recognition_sface_2021dec.onnx',
    url: `${LFS}/face_recognition_sface/face_recognition_sface_2021dec.onnx`,
    minBytes: 30_000_000,
    license: 'Apache 2.0',
  },
]

export type FaceModelsState =
  | { state: 'ready'; dir: string }
  | { state: 'missing' }
  | { state: 'downloading'; percent: number }
  | { state: 'failed'; message: string }

export interface FaceModelsDeps {
  runtimeDir: string
  /** Подменяется в тестах: настоящая закачка ходит в интернет. */
  fetchAsset?: (url: string) => Promise<{
    ok: boolean
    status: number
    body: ReadableStream<Uint8Array> | null
    size: number | null
  }>
}

export class FaceModels {
  private readonly dir: string
  private readonly fetchAsset: NonNullable<FaceModelsDeps['fetchAsset']>
  private state: FaceModelsState = { state: 'missing' }
  private downloading: Promise<string> | null = null

  constructor(deps: FaceModelsDeps) {
    this.dir = path.join(deps.runtimeDir, 'face-models')
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

  getState(): FaceModelsState {
    return this.state
  }

  /** Путь к файлу модели — только по имени из списка: имя приходит из адреса. */
  filePath(name: string): string | null {
    if (!FACE_MODELS.some((model) => model.name === name)) return null
    return path.join(this.dir, name)
  }

  /** Папка с моделями или null, если качать ещё не начинали. */
  async locate(): Promise<string | null> {
    // Идущую закачку опрос состояния не трогает — тот же урок, что с ffmpeg:
    // иначе процент пропадал бы с глаз при каждом опросе.
    const downloading = this.state.state === 'downloading'
    const present = await Promise.all(FACE_MODELS.map(async (model) => {
      const file = path.join(this.dir, model.name)
      const stat = await fs.stat(file).catch(() => null)
      return Boolean(stat?.isFile() && stat.size >= model.minBytes)
    }))
    // Нужны ОБЕ: без детектора лицо не найти, без SFace не с чем сравнивать.
    if (present.every(Boolean)) {
      if (!downloading) this.state = { state: 'ready', dir: this.dir }
      return this.dir
    }
    if (!downloading) this.state = { state: 'missing' }
    return null
  }

  /** Скачать в runtime/face-models. Повторный вызов во время закачки ждёт ту же. */
  download(): Promise<string> {
    if (this.downloading) return this.downloading
    this.state = { state: 'downloading', percent: 0 }
    this.downloading = this.run().finally(() => {
      this.downloading = null
    })
    return this.downloading
  }

  private async run(): Promise<string> {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      const total = FACE_MODELS.length
      for (const [index, model] of FACE_MODELS.entries()) {
        await this.fetchOne(model, index, total)
      }
      this.state = { state: 'ready', dir: this.dir }
      return this.dir
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not download model'
      this.state = { state: 'failed', message }
      throw error instanceof Error ? error : new Error(message)
    }
  }

  private async fetchOne(model: FaceModelSpec, index: number, total: number): Promise<void> {
    const target = path.join(this.dir, model.name)
    const stat = await fs.stat(target).catch(() => null)
    if (stat?.isFile() && stat.size >= model.minBytes) return

    const response = await this.fetchAsset(model.url)
    if (!response.ok || !response.body) {
      throw new Error(`Model ${model.name} was not downloaded (${response.status})`)
    }
    // Пишем во временный файл и переименовываем: оборванная закачка не должна
    // оставить огрызок, который потом примут за готовую модель.
    const tmp = `${target}.part`
    let received = 0
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (!response.size) return
      const own = received / response.size
      const percent = Math.round(((index + Math.min(1, own)) / total) * 100)
      if (this.state.state === 'downloading') this.state = { state: 'downloading', percent }
    })
    try {
      await pipeline(source, createWriteStream(tmp))
      const written = await fs.stat(tmp)
      if (written.size < model.minBytes) {
        // Так выглядит указатель git-lfs или страница с ошибкой вместо модели.
        throw new Error(`Instead of model ${model.name} arrived ${written.size} bytes`)
      }
      await fs.rename(tmp, target)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }
}
