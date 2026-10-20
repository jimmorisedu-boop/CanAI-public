import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { faceModels } from './faceRoutes.js'
import { ffmpegPlatform } from './ffmpegBinary.js'
import { ffmpegBinary } from './ffmpegTools.js'
import { portableToolAsset } from './portableMediaTools.js'
import { loginBrowserInstall } from './loginBrowser.js'

// Опись портативных компонентов: что из скачиваемого сейчас лежит в runtime/.
//
// ⚠️ Опись НИЧЕГО НЕ КАЧАЕТ. Это принципиально: вместе компоненты весят под
// сотню мегабайт, и тянуть их при старте — значит тратить чужой трафик за
// человека, который, может, никогда не станет резать видео. Правило «ничего
// не качается без спроса» действует и здесь; опись только смотрит и
// рассказывает, а кнопки живут в настройках.
//
// Нужна она ради ПОКУПАТЕЛЯ: он распаковывает папку, в которой не скачано
// ничего, и без описи узнаёт об этом только когда полезет резать клип.
// Заодно это диагностика: строка в логе при старте отвечает на вопрос
// «почему у него не работает» без переписки.

export type ComponentState = 'ready' | 'missing' | 'unsupported'

export interface ComponentInfo {
  id: 'ffmpeg' | 'yt-dlp' | 'face-models' | 'login-browser'
  name: string
  /** Зачем он нужен — человеческим языком, а не «бинарник в runtime». */
  purpose: string
  /** Сколько весит закачка: человек вправе знать это до нажатия. */
  sizeHint: string
  state: ComponentState
  /** Готов, но взят из системы, а не своей копией — переедет ли папка? */
  system?: boolean
}

export interface ComponentDeps {
  exists?: (file: string) => Promise<boolean>
  ffmpeg?: () => Promise<{ source: 'runtime' | 'system' } | null>
  faces?: () => Promise<boolean>
  /** Есть ли откуда качать ffmpeg. Внедряется, иначе опись зависела бы от
   *  системы, на которой запущен тест: на Windows сборка качается, на macOS
   *  приезжает в поставке. */
  ffmpegDownloadable?: () => boolean
  /** Состояние браузера для входа. Внедряется по той же причине, что и ffmpeg:
   *  на Windows он качается, а на маке ставится обычным способом. */
  loginBrowser?: () => Promise<ComponentState>
}

const fileExists = (file: string) => fs.stat(file).then((s) => s.isFile(), () => false)

// ⚠️ cloudflared в описи БОЛЬШЕ НЕТ. Публикация давно ходит через relay
// (shareRuntime → createRelayShareTransport), ручка подготовки внешнего
// компонента отвечает 410, и в настройках такого раздела нет вовсе. А опись
// продолжала числить его недостающим — приложение при каждом старте писало
// «не скачаны компоненты: Публикация доски — кнопки в настройках» и посылало
// человека к кнопке, которой не существует (найдено прогоном 20.08.2026).
// Компонент попадает сюда, только если его действительно нечем заменить и
// кнопка для него в настройках ЕСТЬ.
export async function componentInventory(deps: ComponentDeps = {}): Promise<ComponentInfo[]> {
  const exists = deps.exists ?? fileExists
  const ffmpeg = deps.ffmpeg ?? (async () => {
    const found = await ffmpegBinary.locate().catch(() => null)
    if (!found) return null
    const state = ffmpegBinary.getState()
    return { source: state.state === 'ready' ? state.source : 'runtime' }
  })
  const faces = deps.faces ?? (() => faceModels.locate().then(Boolean, () => false))
  const ffmpegDownloadable = deps.ffmpegDownloadable ?? (() => Boolean(ffmpegPlatform()?.asset))
  const loginBrowser = deps.loginBrowser ?? (async () => {
    await loginBrowserInstall.locate().catch(() => null)
    const state = loginBrowserInstall.getState()
    if (state.state === 'ready') return 'ready'
    return state.state === 'unsupported' ? 'unsupported' : 'missing'
  })

  const ytAsset = portableToolAsset('yt-dlp')

  const found = await ffmpeg()
  const [hasYt, hasFaces, browserState] = await Promise.all([
    ytAsset ? exists(path.join(config.mediaToolsDir, ytAsset.fileName)) : Promise.resolve(false),
    faces(),
    loginBrowser(),
  ])

  return [
    {
      id: 'ffmpeg',
      name: 'Processing video and audio',
      purpose: 'Crop, split into shots, extract frames, track, and merge.',
      sizeHint: '≈40 MB',
      // ⚠️ 'unsupported', когда качать неоткуда (macOS: сборка лежит в папке
      // с самого начала). Иначе повторяется история cloudflared из шапки файла:
      // строка в логе и точка в шапке звали бы к кнопке, которой там нет.
      // На Windows asset — строка, значит выражение сводится к прежнему
      // ready|missing, и поведение не меняется ни на шаг.
      state: found ? 'ready' : (ffmpegDownloadable() ? 'missing' : 'unsupported'),
      system: found?.source === 'system',
    },
    {
      id: 'yt-dlp',
      name: 'Download by link',
      purpose: 'Fetches video from a page link.',
      sizeHint: '≈15 MB',
      state: ytAsset ? (hasYt ? 'ready' : 'missing') : 'unsupported',
    },
    {
      id: 'login-browser',
      name: 'Browser for platform sign-in',
      purpose: 'Window for signing in to Vimeo so downloads can be fetched from there.',
      sizeHint: '≈93 MB',
      // 'unsupported' на маке и линуксе: там Firefox ставится обычным способом,
      // а найдём мы его сами — звать к кнопке, которой нет, нельзя (см. шапку).
      state: browserState,
    },
    {
      id: 'face-models',
      name: 'Comparison faces',
      purpose: 'Shows how similar a person is between the source and result.',
      sizeHint: '≈38 MB',
      state: hasFaces ? 'ready' : 'missing',
    },
  ]
}

/** Строка для лога при старте. Пустая, когда всё на месте: молчание в логе —
 *  тоже сообщение, и засорять его строкой «всё хорошо» каждый запуск незачем. */
export function missingComponentsLine(components: ComponentInfo[]): string | null {
  const missing = components.filter((item) => item.state === 'missing')
  if (missing.length === 0) return null
  return `not downloaded components: ${missing.map((item) => item.name).join(', ')} — buttons are in Settings`
}
