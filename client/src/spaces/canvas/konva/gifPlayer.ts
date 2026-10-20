import { useEffect, useState } from 'react'
import { gifFrameDelayMs } from './animatedImageItem'
import { gifFrameAt, gifFrameStartMs, gifTotalMs } from './gifTimeline'
import type { CanvasVideoElement } from './videoPlaybackCoordinator'

/**
 * Проигрыватель GIF для холста — то же, что <video> для клипа (просьба
 * 22.09.2026 «плеер как для видео, только для гиф»).
 *
 * ⚠️ Холст рисует через canvas, а `drawImage` берёт у анимированной картинки
 * только ПЕРВЫЙ кадр (стандарт HTML, замер в Chrome 152). Поэтому кадры
 * разбирает встроенный ImageDecoder, а текущий кадр лежит на своём canvas —
 * его и рисует Konva. Снаружи плеер выглядит как видео (`CanvasVideoElement`),
 * поэтому подключается к тому же координатору: запустил GIF — остановилось
 * игравшее видео, и наоборот.
 */
export class GifPlayer implements CanvasVideoElement {
  /** Текущий кадр — его и рисует Konva. */
  readonly canvas: HTMLCanvasElement
  /** true — кадры разобраны и можно играть; false — не анимирован или не вышло. */
  readonly ready: Promise<boolean>
  private readonly context: CanvasRenderingContext2D | null
  private decoder: ImageDecoder | undefined
  private durations: number[] = []
  private index = 0
  private request = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private closed = false
  private readonly listeners = new Set<() => void>()
  /** Обрывает загрузку файла, когда плеер больше не нужен (см. load). */
  private readonly aborter = new AbortController()

  constructor(src: string) {
    this.canvas = document.createElement('canvas')
    this.context = this.canvas.getContext('2d')
    this.ready = this.load(src).catch(() => false)
  }

  get duration(): number {
    return gifTotalMs(this.durations) / 1000
  }

  get currentTime(): number {
    return gifFrameStartMs(this.durations, this.index) / 1000
  }

  set currentTime(seconds: number) {
    this.show(gifFrameAt(this.durations, seconds * 1000))
  }

  /** У GIF конца нет — он крутится по кругу, пока не поставят на паузу. */
  get ended(): boolean {
    return false
  }

  async play(): Promise<void> {
    if (!(await this.ready) || this.closed) throw new Error('GIF is not animated')
    this.running = true
    this.schedule()
  }

  pause(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Кадр вперёд или назад, по кругу — как стрелки у видео. */
  step(direction: 1 | -1): void {
    const count = this.durations.length
    if (count > 0) this.show((this.index + direction + count) % count)
  }

  /** Сменился кадр — время и перерисовка слоя. */
  onFrame(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  close(): void {
    this.closed = true
    this.aborter.abort()
    this.pause()
    this.listeners.clear()
    this.decoder?.close()
  }

  private async load(src: string): Promise<boolean> {
    if (typeof ImageDecoder === 'undefined') return false
    // ⚠️ Загрузка GIF целиком тормозила ВСЕ картинки доски (жалоба 27.09.2026:
    // «сетевая доска всё равно медленно», на снимке — десятки серых
    // прямоугольников). Причин две, обе замерены в Chrome 152 на стенде:
    // 1. Пока в пути три и больше обычных fetch, браузер придерживает картинки
    //    и отпускает их пачкой раз в 15 секунд: три медленных GIF, как с
    //    сервера команды через VPN, — и каждое превью ждёт 15 026 мс вместо
    //    5. С `priority: 'low'` загрузка встаёт в одну очередь с картинками и
    //    их не держит (те же три GIF — превью за 4–5 мс).
    // 2. Плеер, закрытый раньше, чем пришёл ответ (объект ушёл за край
    //    экрана), бросал ответ непрочитанным. Файл крупнее ~5 МБ браузер
    //    тогда недокачивает и ДЕРЖИТ соединение, пока ответ не соберёт
    //    сборщик мусора, — на доске пользователя три таких GIF висели минутами.
    //    Поэтому close() обрывает загрузку, а ненужный ответ отменяется.
    const response = await fetch(src, { priority: 'low', signal: this.aborter.signal })
    if (!response.ok || this.closed) {
      await response.body?.cancel().catch(() => undefined)
      return false
    }
    const data = await response.arrayBuffer()
    if (this.closed) return false
    const decoder = new ImageDecoder({ data, type: 'image/gif' })
    this.decoder = decoder
    // ⚠️ Порядок важен: `completed` (данные получены) приходит РАНЬШЕ описания
    // дорожки — сразу после него selectedTrack ещё null (замер в Chrome 152),
    // и анимация молча не начиналась. Сначала дорожка, потом полные данные,
    // чтобы число кадров было окончательным.
    await decoder.tracks.ready
    await decoder.completed
    const track = decoder.tracks.selectedTrack
    if (this.closed || !track?.animated || track.frameCount < 2) return false
    // Длительности всех кадров нужны полосе и времени сразу, поэтому разбираем
    // каждый кадр один раз и тут же отпускаем: хранить кадры — это сотни
    // мегабайт на крупном GIF.
    const durations: number[] = []
    for (let i = 0; i < track.frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      try {
        durations.push(gifFrameDelayMs(image.duration))
        if (i === 0) this.draw(image)
      } finally {
        image.close()
      }
      if (this.closed) return false
    }
    this.durations = durations
    return true
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.running || this.closed || this.durations.length === 0) return
      void this.showFrame((this.index + 1) % this.durations.length)
        .then(() => { if (this.running) this.schedule() })
        .catch(() => undefined)
    }, this.durations[this.index] ?? 100)
  }

  private show(index: number): void {
    void this.showFrame(index).catch(() => undefined)
  }

  private async showFrame(index: number): Promise<void> {
    if (!this.decoder || this.closed) return
    const request = ++this.request
    const { image } = await this.decoder.decode({ frameIndex: index })
    try {
      // Пока кадр разбирался, попросили другой (перемотка) — этот устарел.
      if (request !== this.request || this.closed) return
      this.draw(image)
      this.index = index
    } finally {
      image.close()
    }
    for (const listener of this.listeners) listener()
  }

  private draw(image: VideoFrame): void {
    if (!this.context) return
    if (this.canvas.width !== image.displayWidth || this.canvas.height !== image.displayHeight) {
      this.canvas.width = image.displayWidth
      this.canvas.height = image.displayHeight
    }
    // Кадр от ImageDecoder уже собран целиком (с учётом способа смены кадров
    // GIF), поэтому рисуем его на чистое поле.
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.context.drawImage(image, 0, 0)
  }
}

/** Разбирать кадры GIF здесь умеют (нет ImageDecoder — Firefox, Safari). */
export function canPlayGif(): boolean {
  return typeof ImageDecoder !== 'undefined'
}

/**
 * Проигрыватель для фигуры: появляется, когда кадры разобраны. Пока его нет,
 * фигура показывает обычную картинку — это и есть первый кадр. Нет
 * ImageDecoder (Firefox, Safari) или GIF не анимирован — плеера не будет.
 * Живёт, пока фигура на экране: культинг размонтирует её за краем.
 *
 * `still` — файл разобран и играть в нём нечего (один кадр или не вышло):
 * значок ▶ тогда убирается, чтобы не обещать того, чего нет.
 */
export function useGifPlayer(
  src: string | undefined,
  enabled: boolean,
): { player: GifPlayer | undefined; still: boolean } {
  const [player, setPlayer] = useState<GifPlayer>()
  const [still, setStill] = useState(false)
  useEffect(() => {
    setPlayer(undefined)
    setStill(false)
    if (!enabled || !src || !canPlayGif()) return
    const created = new GifPlayer(src)
    let alive = true
    void created.ready.then((ok) => {
      if (!alive) return
      if (ok) setPlayer(created)
      else setStill(true)
    })
    return () => {
      alive = false
      created.close()
    }
  }, [src, enabled])
  return { player, still }
}
