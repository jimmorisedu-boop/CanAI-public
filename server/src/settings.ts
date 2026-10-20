import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config, envFile } from './config.js'
import { reconfigureFal } from './fal.js'
import { setGenerationTransport } from './generationAvailability.js'

// Настройки приложения. Лежат в data/settings.json — переезжают вместе с папкой.
export interface AppSettings {
  externalEditorPath: string | null
  optimiseLargeImages: boolean
  confirmCostAboveUsd: number
  assistantModelId: string
  assistantSystemPrompt: string
  /** Пускать гостей по локальной сети, без Tailscale. По умолчанию выключено:
   *  гостевой сервер слушает только этот компьютер. */
  shareLanAccess: boolean
  /** Порог сходства лиц: выше — «тот же человек». Значение по умолчанию
   *  замерено на настоящих датасетах, см. faceMath.ts на клиенте. */
  faceThreshold: number
  /**
   * Вход на площадки для импорта по ссылке: 'none' — анонимно (как было
   * всегда), 'app' — окно входа самого приложения (основной путь, кнопка на
   * карточке ссылки), 'file' — файл cookies для тех, у кого нет Firefox.
   * Разбор и ограничения — extractorCookies.ts.
   */
  extractorCookiesMode: 'none' | 'app' | 'file'
  extractorCookiesFile: string | null
  /**
   * Сколько локальных оплачиваемых генераций за день можно запустить с
   * планшета (через PIN-вход). 0 = лимит выключен, можно без ограничений.
   * Счётчик сам сбрасывается в полночь. Для компьютера хозяина лимита нет —
   * там есть отдельное подтверждение цены (confirmCostAboveUsd).
   */
  tabletDailyGenerationLimit: number
  /**
   * Дневной лимит подтверждённых ПЛАТНЫХ решений агентов с планшета
   * (approve карточки согласования, за которой стоит оплачиваемая генерация
   * fal). 0 = выключен. То же правило, что у генераций: счётчик сам
   * сбрасывается в полночь; планшет сам лимит менять не может.
   */
  tabletApproveDailyLimit: number
  /**
   * Где выполнять генерацию: 'local' — напрямую в fal своим ключом (как было
   * всегда), 'cloud' — через сервер CanAI.
   *
   * ⚠️ По умолчанию ВСЕГДА 'local'. Приложение обязано работать без нашего
   * сервера — это тот же инвариант, что «работает без ключа»; переключатель
   * лишь выбирает путь, а не делает облако обязательным.
   */
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

let settingsQueue: Promise<unknown> = Promise.resolve()
function withSettingsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = settingsQueue.then(fn, fn)
  settingsQueue = next.then(() => undefined, () => undefined)
  return next
}

// Ключ fal живёт в server/.env (gitignored, переезжает с папкой). Раньше
// покупателю приходилось редактировать файл руками — теперь поле в настройках.
// Сам ключ наружу не отдаётся (только факт «задан/нет»), сервер слушает loopback.
export async function saveFalKey(key: string | null): Promise<void> {
  return withSettingsLock(async () => {
    let lines: string[] = []
    try {
      const raw = await fs.readFile(envFile, 'utf8')
      lines = raw.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('FAL_KEY='))
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    if (key) lines.unshift(`FAL_KEY=${key}`)
    const tmp = `${envFile}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, lines.join('\n') + (lines.length ? '\n' : ''))
      await fs.rename(tmp, envFile)
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
    config.falKey = key
    reconfigureFal()
  })
}

const DEFAULTS: AppSettings = { externalEditorPath: null, optimiseLargeImages: false, confirmCostAboveUsd: 1, assistantModelId: 'gemini', assistantSystemPrompt: '', shareLanAccess: false, faceThreshold: 0.36, extractorCookiesMode: 'none', extractorCookiesFile: null, tabletDailyGenerationLimit: 0, tabletApproveDailyLimit: 0 }

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(config.settingsFile, 'utf8')) as Partial<AppSettings>
    return { ...DEFAULTS, ...raw }
  } catch (err) {
    if (isNotFound(err)) return { ...DEFAULTS }
    throw err
  }
}

/** Держим выбранный путь в памяти: доступность проверяется на каждый запуск. */
export async function saveSettings(settings: AppSettings): Promise<void> {
  return withSettingsLock(async () => {
    await fs.mkdir(path.dirname(config.settingsFile), { recursive: true })
    const tmp = `${config.settingsFile}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(settings, null, 2))
      await fs.rename(tmp, config.settingsFile)
      // Доступность генерации спрашивают на каждый запуск — читать файл каждый
      // раз незачем, поэтому выбранный путь запоминается здесь же.
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  })
}
