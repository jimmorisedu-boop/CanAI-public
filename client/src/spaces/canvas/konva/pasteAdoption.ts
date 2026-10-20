import type { CanvasItem } from './types'
import type { ProjectRef } from '../../../types'

/**
 * Файлы вставленных объектов переселяются туда, где живёт доска назначения.
 *
 * ⚠️ **Объект с чужим файлом на сетевой доске — призрак: он виден только
 * тому, кто его вставил.** Жалоба 20.09.2026 с записью экрана: «растягиваю,
 * он тянется, а потом обратно возвращается», видео были вставлены с другой
 * доски. Разбор по коду и по серверу команды даёт полную цепочку:
 *
 * 1. Объект, скопированный с ЛОКАЛЬНОЙ доски, несёт ссылку `/media/…` и НЕ
 *    несёт `assetId` — файл лежит на своём сервере, у команды его нет.
 * 2. Появление такого объекта наш же предохранитель на общую доску не
 *    пускает (`nonPortableCloudPayload`): сервер отклонил бы его на разборе,
 *    а это рвёт связь с доской. Объект остаётся местным.
 * 3. Дальше начинается самое неприятное. Перенос и размер — это `x/y/w/h`,
 *    они ПЕРЕНОСИМЫ, и такая правка на сервер уходит. Он отвечает
 *    «Изменяемый объект не существует» (conflict), клиент читает это как
 *    «устарело» и убирает правку МОЛЧА — по общему правилу, которое для
 *    настоящего устаревания верно.
 * 4. Итог: объект тянется под рукой и прыгает обратно. Каждый раз, без
 *    единого слова, и починить это человек не может никак.
 *
 * Поэтому файл переселяется СРАЗУ при вставке: тем же `adoptForBoard`, что
 * уже переселяет нарезку клипа и отделённый звук. После этого объект обычный
 * и ничем не отличается от рождённого на этой доске.
 *
 * ⚠️ Файл ДРУГОЙ СЕТЕВОЙ доски тоже чужой, хотя `assetId` у него есть: читать
 * его пускают только тех, у кого есть доступ к доске-хозяйке, и коллега без
 * такого доступа видел битый файл (находка Ф-8 аудита 24.09.2026). Какая доска
 * хозяйка, знает буфер обмена: он помнит, откуда скопировано (`origin`). Буфер
 * без этой отметки (скопировано до обновления) считаем своим — как было.
 *
 * ⚠️ Не получилось переселить — объект НЕ вставляется, его карточка краснеет.
 * Призрак, который выглядит настоящим, хуже несостоявшейся вставки: работу над
 * ним не сохранить, а узнать об этом неоткуда.
 */

/** Виды, у которых есть файл. У текста и карточки ссылки переселять нечего. */
const MEDIA_KINDS = new Set(['image', 'video', 'audio'])
const CLOUD_MEDIA = /^\/(?:api\/cloud-assets|v3)\/assets\/[A-Za-z0-9_-]{1,120}$/

export interface AdoptedMedia {
  assetId?: string
  url: string
  mime: string
}

export interface MediaToAdopt {
  url: string
  mime: string
  /** Файл сетевой доски — его сервер команды умеет скопировать у себя. */
  assetId?: string
}

export type MediaAdopter = (
  media: MediaToAdopt,
  name: string,
  hooks?: { onProgress?(loaded: number, total: number): void },
) => Promise<AdoptedMedia>

function sameCloudBoard(origin: ProjectRef | null | undefined, destination: ProjectRef): boolean {
  // Без отметки — буфер из прежней версии: считаем своим, как было до неё.
  return !origin || (origin.source === 'cloud' && origin.id === destination.id)
}

/** Нужно ли этому файлу переселиться на доску назначения. */
function mediaNeedsAdoption(
  media: MediaToAdopt,
  destination: ProjectRef | null,
  origin: ProjectRef | null | undefined,
): boolean {
  // Доска назначения неизвестна — переселять некуда, объект ложится как есть.
  if (!destination) return false
  if (destination.source === 'local') return CLOUD_MEDIA.test(media.url.split('?')[0] ?? '')
  if (!media.assetId) return true
  return !sameCloudBoard(origin, destination)
}

function mainMedia(item: CanvasItem): MediaToAdopt | null {
  if (!MEDIA_KINDS.has(item.kind) || !item.src) return null
  return { url: item.src, mime: item.mime ?? '', ...(item.assetId ? { assetId: item.assetId } : {}) }
}

/** Исходник неразрушающего кропа — тоже файл, и без него кроп не расширить. */
function cropMedia(item: CanvasItem): MediaToAdopt | null {
  const crop = item.crop
  if (!MEDIA_KINDS.has(item.kind) || !crop?.sourceSrc) return null
  return {
    url: crop.sourceSrc,
    mime: crop.sourceMime ?? item.mime ?? '',
    ...(crop.sourceAssetId ? { assetId: crop.sourceAssetId } : {}),
  }
}

/** Файл должен жить на целевой доске: облачный assetId не делает его локальным. */
export function needsAdoption(
  item: CanvasItem,
  destination: ProjectRef | null = null,
  origin: ProjectRef | null = null,
): boolean {
  const main = mainMedia(item)
  if (main && mediaNeedsAdoption(main, destination, origin)) return true
  const crop = cropMedia(item)
  return Boolean(crop && mediaNeedsAdoption(crop, destination, origin))
}

/**
 * Переселить файлы одного объекта. Возвращает объект с новыми ссылками;
 * бросает, если файл переселить не вышло.
 */
export async function adoptPastedItem(
  item: CanvasItem,
  adopt: MediaAdopter,
  destination: ProjectRef | null = null,
  origin: ProjectRef | null = null,
  hooks: { onProgress?(loaded: number, total: number): void } = {},
): Promise<CanvasItem> {
  let next = item
  const main = mainMedia(item)
  if (main && mediaNeedsAdoption(main, destination, origin)) {
    const adopted = await adopt(main, item.name || 'file', hooks)
    const { assetId: _sourceAssetId, ...portableItem } = next
    next = {
      ...portableItem,
      src: adopted.url,
      ...(adopted.assetId ? { assetId: adopted.assetId } : {}),
      ...(adopted.mime ? { mime: adopted.mime } : {}),
    }
  }
  const crop = cropMedia(item)
  if (crop && next.crop && mediaNeedsAdoption(crop, destination, origin)) {
    const adopted = await adopt(crop, `${item.name || 'file'} — source`)
    const { sourceAssetId: _sourceAssetId, ...portableCrop } = next.crop
    next = {
      ...next,
      crop: {
        ...portableCrop,
        sourceSrc: adopted.url,
        ...(adopted.assetId ? { sourceAssetId: adopted.assetId } : {}),
        ...(adopted.mime ? { sourceMime: adopted.mime } : {}),
      },
    }
  }
  return next
}
