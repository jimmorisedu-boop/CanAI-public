import type { CanvasStore } from './canvasStore'
import type { CanvasItem } from './types'
import type { ProjectRef } from '../../../types'
import { OWN_CLIPBOARD_TYPE } from './pasteDecision'
import { adoptForBoard, getBoardUploadTarget } from './boardUploader'
import type { MediaAdopter } from './pasteAdoption'
import { pasteWithCards, type PasteStore } from './pasteProgress'
import { showErrorToast } from '../toastBus'
import { isSafeCanvasLinkData } from './mediaLinkUrl'
import { clipboardImageSource, copyImageToSystemClipboard } from './systemClipboardImage'
import { plural } from '../../../ui/plural'

// Буфер обмена холста (Ctrl+C/V). Сохраняем в localStorage, чтобы
// копирование работало между разными вкладками браузера и досками.

// Удалось ли положить нашу метку в СИСТЕМНЫЙ буфер. Знание нужно вставке
// (см. decidePaste): если запись запрещена, в системном буфере лежит чужой
// СТАРЫЙ текст, и принять его за свежую копию — значит сломать обычный
// Ctrl+C→Ctrl+V по объектам холста.
//
// ⚠️ Помнить надо ПРОВАЛ, а не успех, и помнить его В ХРАНИЛИЩЕ. Раньше это
// был флаг «успех» в памяти модуля: он сбрасывался при каждом запуске, а
// внутренний буфер живёт в localStorage и переживает всё. Итог: после
// перезапуска приложения любая внешняя вставка (ссылка, текст) молча
// проигрывала давней копии объектов — вместо ссылки на холст падали старые
// картинки. Провал же случается редко и относится к КОНКРЕТНОЙ копии,
// поэтому хранится рядом с ней и переживает перезапуск вместе с ней.
const MIRROR_FAILED_KEY = 'canai-clipboard-mirror-failed'
let mirrorAttempt = 0

/**
 * С какой доски скопировано.
 *
 * ⚠️ Файл сетевой доски, вставленный на ДРУГУЮ сетевую доску, должен стать
 * её собственным — иначе коллега без доступа к доске-хозяйке видит битый файл
 * (находка Ф-8 аудита 24.09.2026). По самому объекту хозяйку не узнать: у
 * него только `assetId`. Поэтому буфер помнит доску, где было сделано Ctrl+C.
 */
const ORIGIN_KEY = 'canai-clipboard-origin'

function parseOrigin(value: unknown): ProjectRef | null {
  if (!value || typeof value !== 'object') return null
  const { source, id } = value as { source?: unknown; id?: unknown }
  if (source !== 'local' && source !== 'cloud') return null
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:~-]{1,160}$/.test(id)) return null
  return { source, id }
}

function rememberOrigin(origin: ProjectRef | null): void {
  try {
    if (origin) localStorage.setItem(ORIGIN_KEY, JSON.stringify(origin))
    else localStorage.removeItem(ORIGIN_KEY)
  } catch {
    // Без отметки вставка сочтёт буфер своим — как было до неё.
  }
}

function storedOrigin(): ProjectRef | null {
  try {
    const raw = localStorage.getItem(ORIGIN_KEY)
    return raw ? parseOrigin(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function rememberMirror(ok: boolean): void {
  try {
    if (ok) localStorage.removeItem(MIRROR_FAILED_KEY)
    else localStorage.setItem(MIRROR_FAILED_KEY, '1')
  } catch {
    // Хранилище недоступно — вставка просто будет доверять системному буферу.
  }
}

/** Точно ли известно, что нашу копию НЕ удалось положить в системный буфер. */
export function clipboardMirrorFailed(): boolean {
  try {
    return localStorage.getItem(MIRROR_FAILED_KEY) === '1'
  } catch {
    return false
  }
}

export interface CanvasClipboardWriter {
  setData(type: string, value: string): void
}

interface CopySelectedDeps {
  copyImage?(item: CanvasItem, ownPayload: string, options?: { after?: Promise<unknown> }): Promise<boolean>
  writeText?(payload: string): Promise<void>
}

export function copySelected(
  store: CanvasStore,
  writer?: CanvasClipboardWriter,
  deps: CopySelectedDeps = {},
): number {
  const sel = store.getSelectedItems()
  if (sel.length > 0) {
    const attempt = ++mirrorAttempt
    // Картинка уезжает в системный буфер отдельно и вместе с нашей меткой —
    // чтобы её приняли Photoshop и любая другая программа (см.
    // systemClipboardImage). Внутреннее копирование от этого не зависит:
    // оно уже сделано ниже, и отказ браузера его не отменяет.
    const shared = clipboardImageSource(sel)
    const copied = sel.map((item) => item.kind === 'link' && item.link
      ? { ...item, link: { ...item.link, activeImportId: undefined, downloadedItemIds: {} } }
      : { ...item })
    const origin = getBoardUploadTarget()
    const payload = JSON.stringify({ type: OWN_CLIPBOARD_TYPE, items: copied, ...(origin ? { origin } : {}) })
    try {
      localStorage.setItem('canai-clipboard', JSON.stringify(copied))
    } catch (err) {
      console.error('[CanAI] Failed to save clipboard to localStorage:', err)
    }
    rememberOrigin(origin)
    if (shared) {
      // ⚠️ Метка ложится в системный буфер СРАЗУ, картинка — следом и вместе
      // с той же меткой (одним ClipboardItem). Раньше ждали одну картинку, а
      // её надо скачать и отдать браузеру: всё это время — и навсегда, если
      // запись не удалась, — в буфере лежало то, что было ДО копирования.
      // Ctrl+V клал на доску давний снимок экрана вместо скопированной
      // картинки (жалоба 01.10.2026: «копирую одну картинку, а вставляется
      // другая»; в журнале доски — четыре вставки одного и того же image.png).
      // ⚠️ Порядок важен: метка — ДО картинки. ПОСЛЕ картинки писать текст
      // нельзя — он перетрёт PNG, и чужая программа получит служебный JSON.
      const copyImage = deps.copyImage ?? copyImageToSystemClipboard
      let marked = false
      let textSettled: Promise<unknown> = Promise.resolve()
      if (writer) {
        try {
          writer.setData('text/plain', payload)
          marked = true
        } catch {
          // Оболочка не разрешила setData — ниже остаётся запись через writeText.
        }
      }
      if (!marked) {
        const writeText = deps.writeText
          ?? (typeof navigator !== 'undefined' && navigator.clipboard?.writeText
            ? (value: string) => navigator.clipboard.writeText(value)
            : null)
        if (writeText) {
          try {
            textSettled = writeText(payload).then(() => { marked = true }, () => {})
          } catch {
            // Нет доступа к буферу — отметка о провале ниже скажет об этом вставке.
          }
        }
      }
      // Пока метка не легла, в буфере чужое и СТАРОЕ — вставка обязана это знать.
      rememberMirror(marked)
      const settle = (ok: boolean): void => {
        if (attempt === mirrorAttempt) rememberMirror(ok || marked)
      }
      void textSettled.then(() => settle(false))
      void copyImage(shared, payload, { after: textSettled }).then(settle, () => settle(false))
      return sel.length
    }
    if (writer) {
      try {
        writer.setData('text/plain', payload)
        rememberMirror(true)
        return sel.length
      } catch {
        // Некоторые оболочки не разрешают setData — ниже остаётся async fallback.
      }
    }
    try {
      const writeText = deps.writeText
        ?? (typeof navigator !== 'undefined' && navigator.clipboard?.writeText
          ? (value: string) => navigator.clipboard.writeText(value)
          : null)
      if (writeText) {
        void writeText(payload)
          .then(() => {
            if (attempt === mirrorAttempt) rememberMirror(true)
          })
          .catch(() => {
            if (attempt === mirrorAttempt) rememberMirror(false)
          })
      } else {
        rememberMirror(false)
      }
    } catch {
      // Игнорируем отсутствие доступа к нативному буферу
      rememberMirror(false)
    }
  }
  return sel.length
}

export function hasClipboard(): boolean {
  try {
    const raw = localStorage.getItem('canai-clipboard')
    if (raw) {
      const items = JSON.parse(raw)
      return Array.isArray(items) && items.length > 0
    }
  } catch {
    // игнорируем ошибки
  }
  return false
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isClipboardItem(value: unknown): value is CanvasItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 100) return false
  if (
    item.kind !== 'image' && item.kind !== 'video' && item.kind !== 'text'
    && item.kind !== 'link' && item.kind !== 'audio'
  ) return false
  if (![item.x, item.y, item.w, item.h].every(isFiniteNumber)) return false
  if ((item.w as number) <= 0 || (item.h as number) <= 0) return false
  if (item.kind === 'text') {
    return item.text === undefined || (typeof item.text === 'string' && item.text.length <= 200_000)
  }
  if (item.kind === 'link') {
    return item.src === undefined && isSafeCanvasLinkData(item.link)
  }
  if (typeof item.src !== 'string' || item.src.includes('data:')) return false
  if (item.src.startsWith('/media/')) return true
  const cloudAsset = /^\/(?:api\/cloud-assets|v3)\/assets\/([A-Za-z0-9_-]{1,120})$/.exec(item.src)
  return Boolean(cloudAsset && cloudAsset[1] === item.assetId)
}

// Системная метка содержит сами объекты. Восстанавливаем localStorage после
// reload/перехода в другую вкладку, где модульный флаг и внутренний буфер могли
// начаться с нуля. Чужой или чрезмерный JSON никогда не принимаем.
export interface CanvasClipboard {
  items: CanvasItem[]
  /** Доска, где сделано Ctrl+C; у буфера из прежней версии её нет. */
  origin: ProjectRef | null
}

export function canvasClipboardFromSystem(text: string): CanvasClipboard {
  const empty: CanvasClipboard = { items: [], origin: null }
  if (text.length === 0 || text.length > 5_000_000) return empty
  try {
    const payload = JSON.parse(text) as { type?: unknown; items?: unknown; origin?: unknown }
    if (payload.type !== OWN_CLIPBOARD_TYPE || !Array.isArray(payload.items)) return empty
    if (payload.items.length === 0 || payload.items.length > 1000) return empty
    if (!payload.items.every(isClipboardItem)) return empty
    return { items: payload.items, origin: parseOrigin(payload.origin) }
  } catch {
    return empty
  }
}

export function canvasItemsFromSystemClipboard(text: string): CanvasItem[] {
  return canvasClipboardFromSystem(text).items
}

export function syncInternalClipboardFromSystem(text: string): boolean {
  const { items, origin } = canvasClipboardFromSystem(text)
  if (items.length === 0) return false
  try {
    localStorage.setItem('canai-clipboard', JSON.stringify(items))
  } catch {
    return false
  }
  rememberOrigin(origin)
  return true
}

/**
 * Положить скопированные объекты на доску — ЕДИНСТВЕННАЯ дверь для вставки.
 *
 * ⚠️ Вставка на СЕТЕВУЮ доску сперва переселяет файлы на сервер команды.
 * Объект с чужим файлом сервер не примет, останется местным — и дальше будет
 * тянуться под рукой и прыгать обратно, молча (см. pasteAdoption.ts).
 * На локальной доске свой /media/ проходит насквозь, а облачный assetId
 * сначала скачивается и сохраняется в её /media/.
 *
 * ⚠️ **У Ctrl+V ДВА пути, и переселение стояло только на одном.** После
 * Ctrl+C объекты лежат и во внутреннем буфере, и в системном (нашей меткой с
 * самими объектами), а вставку в браузере первым ловит событие `paste` — и
 * оно клало объекты из системного буфера прямо в стор, мимо переселения.
 * Починка 20.09.2026 закрыла путь, по которому настоящий Ctrl+V почти не
 * ходит: призраки рождались дальше (жалоба 21.09.2026 с записью экрана,
 * журнал сервера команды — «Изменяемый объект не существует» на новой доске
 * через девять секунд после её создания). Теперь оба пути идут сюда, а
 * прямой `store.pasteItems`/`store.insertPasted` вне этого места не пускает
 * сторож `pasteAdoption.test.ts`.
 *
 * ⚠️ Объекты, чьи файлы переезжают, встают не разом: на их месте сразу
 * карточки, а объект появляется, как только готов его файл (pasteProgress.ts).
 * Не переехал — карточка краснеет с «Повторить», остальные на месте.
 */
export async function pasteCanvasItems(
  store: PasteStore,
  items: CanvasItem[],
  targetWorld?: { x: number; y: number },
  viewportSize?: { w: number; h: number },
  options: { origin?: ProjectRef | null; adopt?: MediaAdopter } = {},
): Promise<string[]> {
  if (items.length === 0) return []
  const destination = getBoardUploadTarget()
  const { placed, failed } = await pasteWithCards(store, items, targetWorld, viewportSize, {
    destination,
    origin: options.origin ?? null,
    adopt: options.adopt ?? ((media, name, hooks) => adoptForBoard(media, name, destination, hooks)),
  })
  if (failed.length > 0) showErrorToast(failedPasteNotice(failed))
  return placed
}

/**
 * Что сказать, когда часть файлов не переехала.
 *
 * Карточки уже на доске и называют причину — здесь только куда смотреть.
 */
export function failedPasteNotice(failed: readonly string[]): string {
  const named = failed.slice(0, 2).map((name) => `«${name}»`).join(', ')
  const rest = failed.length > 2 ? ` and ${failed.length - 2}` : ''
  const noun = plural(failed.length, ['file was not transferred', 'files were not transferred', 'files were not transferred'])
  return failed.length === 1
    ? `${named} was not transferred to the board; its card has “Retry”`
    : `${failed.length} ${noun}: ${named}${rest} — their cards have “Retry”`
}

/** Вставка из внутреннего буфера (горячая клавиша, меню, планшет). */
export async function paste(
  store: CanvasStore,
  targetWorld?: { x: number; y: number },
  viewportSize?: { w: number; h: number },
): Promise<void> {
  let items: CanvasItem[]
  try {
    const raw = localStorage.getItem('canai-clipboard')
    if (!raw) return
    const parsed = JSON.parse(raw) as CanvasItem[]
    if (!Array.isArray(parsed) || parsed.length === 0) return
    items = parsed
  } catch (err) {
    console.error('[CanAI] Failed to read clipboard:', err)
    return
  }
  await pasteCanvasItems(store, items, targetWorld, viewportSize, { origin: storedOrigin() })
}
