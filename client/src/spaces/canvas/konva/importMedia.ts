import { api } from '../../../api'
import type { CanvasStore } from './canvasStore'
import { startImport } from '../importQueue'
import { mediaKind, type MediaKind } from './clipboardMedia'
import { layoutMediaGrid, type MediaGridOptions } from './mediaGridLayout'
import { AUDIO_ITEM_HEIGHT, AUDIO_ITEM_WIDTH } from './audioMeta'
import type { ProjectRef } from '../../../types'

/**
 * Размеры кадра — и заодно ответ на вопрос, читается ли файл вообще.
 *
 * ⚠️ `readable: false` — это не догадка о формате, а ПРИГОВОР того самого
 * декодера, которым фигура будет рисоваться на холсте: и здесь, и в Konva
 * работает обычный `<img>`/`<video>` браузера. Значит файл, не прочитанный
 * тут, на доске будет ПУСТОЙ КАРТОЧКОЙ — и молча класть его туда нельзя
 * (см. importFilesAt).
 */
export function measure(file: Blob, isImage: boolean): Promise<{ w: number; h: number; readable: boolean }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const done = (w: number, h: number, readable = true) => {
      URL.revokeObjectURL(url)
      resolve({ w: w || 1024, h: h || 768, readable })
    }
    if (isImage) {
      const img = new Image()
      img.onload = () => done(img.naturalWidth, img.naturalHeight)
      img.onerror = () => done(0, 0, false)
      img.src = url
    } else {
      const video = document.createElement('video')
      video.onloadedmetadata = () => done(video.videoWidth, video.videoHeight)
      video.onerror = () => done(0, 0, false)
      video.src = url
    }
  })
}

// У звука нет ширины и высоты — плашка всегда одного размера. Измерять у него
// имеет смысл только длительность: она попадёт в подпись под именем.
export function measureAudio(file: Blob): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = document.createElement('audio')
    const done = (value: number | undefined) => {
      URL.revokeObjectURL(url)
      resolve(value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined)
    }
    audio.onloadedmetadata = () => done(audio.duration)
    audio.onerror = () => done(undefined)
    audio.src = url
  })
}

async function attachPeaks(store: CanvasStore, itemId: string | undefined, src: string): Promise<void> {
  if (!itemId) return
  try {
    const { peaks } = await api.audioPeaks(src)
    // Объект мог уехать в архив или быть удалён, пока считалась волна —
    // updateItem по несуществующему id просто ничего не делает.
    if (peaks && peaks.length > 0) store.updateItem(itemId, { peaks }, false)
  } catch {
    // Без ffmpeg волны не будет — плашка нарисуется полосой, и это норма.
  }
}

interface ImportedSize {
  w: number
  h: number
  duration?: number
  /** Прочитал ли файл сам браузер — см. measure и отказ в importFilesAt. */
  readable: boolean
}

function measureEntry(file: File, kind: MediaKind): Promise<ImportedSize> {
  // У звука читаемость не проверяем: плашка осмысленна и без длительности
  // (имя и кнопка воспроизведения на месте), а `onerror` у <audio> срабатывает
  // и на контейнерах, которые браузер просто не берётся играть.
  if (kind === 'audio') {
    return measureAudio(file)
      .then((duration) => ({ w: AUDIO_ITEM_WIDTH, h: AUDIO_ITEM_HEIGHT, duration, readable: true }))
  }
  return measure(file, kind === 'image')
}

/**
 * Отказ, который называет файл по имени.
 *
 * «Не удалось импортировать» человеку не говорит ничего: из десятка
 * перетащенных файлов он не поймёт, какой именно не взяли и почему.
 */
function unreadableMessage(names: string[]): string {
  const shown = names.slice(0, 3).map((name) => `«${name}»`).join(', ')
  const rest = names.length > 3 ? ` and ${names.length - 3}` : ''
  return names.length === 1
    ? `${shown} could not be opened: the file is damaged or its contents do not match the extension`
    : `Could not open ${shown}${rest}: files are damaged or their contents do not match the extension`
}

function linkedSignal(first: AbortSignal, second?: AbortSignal): AbortSignal {
  if (!second) return first
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of [first, second]) {
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

// Единый batch-путь для drop, clipboard и file picker. Слоты считаются до
// загрузки, поэтому быстрый файл не обгоняет медленный и не меняет порядок.
export async function importFilesAt(
  store: CanvasStore,
  files: File[],
  world: { x: number; y: number },
  layout: MediaGridOptions = {},
  signal?: AbortSignal,
  projectRef?: ProjectRef,
  uploader?: (
    file: File,
    signal: AbortSignal,
    progress: (loaded: number, total: number) => void,
  ) => Promise<{ src: string; mime: string; assetId?: string; assetRevision?: number; assetChecksum?: string }>,
): Promise<string[]> {
  const entries = files
    .map((file) => ({ file, kind: mediaKind(file) }))
    .filter((entry): entry is { file: File; kind: MediaKind } => entry.kind !== null)
  if (entries.length === 0) return []
  signal?.throwIfAborted()
  const measured = await Promise.all(entries.map(({ file, kind }) => measureEntry(file, kind)))
  signal?.throwIfAborted()
  // ⚠️ Нечитаемый файл на доску НЕ ложится. Раньше `measure` подменял его
  // размеры на 1024×768, файл уезжал на сервер и вставал пустой карточкой без
  // единого слова: текст, переименованный в `.png`, и мусор с расширением
  // `.jpg` принимались наравне с картинками (найдено прогоном 17.09.2026).
  // Отказ честнее пустой карточки: рисовать такой файл будет тот же декодер
  // браузера, что уже отказался его прочитать, — значит на холсте не появится
  // ничего и дальше. Остальные файлы партии при этом доезжают: одна битая
  // картинка среди десяти не повод отменить весь импорт.
  const unreadable = entries.filter((_, index) => !measured[index].readable).map(({ file }) => file.name || 'file')
  const sizes = measured.filter((size) => size.readable)
  const readable = entries.filter((_, index) => measured[index].readable)
  if (readable.length === 0) throw new Error(unreadableMessage(unreadable))
  const rects = layoutMediaGrid(
    sizes.map(({ w, h }) => ({ width: w, height: h })),
    world,
    layout,
  )
  const importedIds: string[] = []
  const uploadPendingIds: Array<string | undefined> = []
  const results = await Promise.allSettled(readable.map(({ file, kind }, index) =>
    startImport(file, async (queueSignal, progress) => {
      // ⚠️ «Повторить» в панели загрузок вызывает эту же операцию заново, а
      // карточку загрузки прошлая попытка при сбое уже убрала (finally ниже).
      // Без новой карточки проверка «карточку удалили — файл не воскрешаем»
      // молча выбрасывала залитый файл: трафик потрачен, объекта нет, слова
      // тоже нет (находка Ф-3 аудита 24.09.2026). Повтор — осознанное
      // действие человека, поэтому карточка встаёт на прежнее место.
      try {
        const uploadSignal = linkedSignal(queueSignal, signal)
        uploadSignal.throwIfAborted()
        const reportProgress = (loaded: number, total: number) => {
          progress(loaded, total)
          if (uploadPendingIds[index] && total > 0) {
            store.updatePending(uploadPendingIds[index], {
              stage: `Uploading · ${Math.min(100, Math.round(loaded / total * 100))}%`,
            }, { system: true })
          }
        }
        const uploaded = uploader
          ? await uploader(file, uploadSignal, reportProgress)
          : await api.uploadFile(file, uploadSignal, reportProgress)
        uploadSignal.throwIfAborted()
        const pendingId = uploadPendingIds[index]
        const pending = pendingId ? store.getPending().find((item) => item.id === pendingId) : null
        // Удалённая во время передачи карточка не должна воскресать готовым
        // файлом. Если её перенесли/изменили, файл встаёт на новое место.
        if (pendingId && !pending) return
        const finalRect = pending
          ? { x: pending.x, y: pending.y, w: pending.w, h: pending.h }
          : rects[index]
        if (pendingId) store.dismissPendingById(pendingId)
        const uploadedAsset = uploaded as {
          src?: string
          url?: string
          mime: string
          assetId?: string
          assetRevision?: number
          assetChecksum?: string
        }
        importedIds[index] = store.addImportedRect(
          {
            kind,
            src: uploadedAsset.src ?? uploadedAsset.url ?? '',
            mime: uploadedAsset.mime,
            assetId: uploadedAsset.assetId,
            assetRevision: uploadedAsset.assetRevision,
            assetChecksum: uploadedAsset.assetChecksum,
            name: file.name || 'file',
            naturalW: sizes[index].w,
            naturalH: sizes[index].h,
            duration: sizes[index].duration,
          },
          finalRect,
          false,
        )
        // Волну считает сервер, и ждать её незачем: объект должен появиться
        // сразу, а картинка догонит. Шагом истории это НЕ становится — иначе
        // первый Ctrl+Z отменял бы появление волны, а не импорт файла.
        if (kind === 'audio' && 'url' in uploaded) {
          void attachPeaks(store, importedIds[index], uploaded.url)
        }
      } finally {
        if (uploadPendingIds[index]) store.dismissPendingById(uploadPendingIds[index])
      }
    }),
  ))
  const selectedIds = importedIds.filter(Boolean)
  if (selectedIds.length > 0) store.setSelection(selectedIds)
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
  // Про отброшенные говорим ПОСЛЕ того, как остальные встали на доску: сначала
  // работа, потом объяснение, чего в ней не хватает.
  if (unreadable.length > 0) throw new Error(unreadableMessage(unreadable))
  return selectedIds
}

export async function importFileAt(
  store: CanvasStore,
  file: File,
  world: { x: number; y: number },
  signal?: AbortSignal,
  projectRef?: ProjectRef,
): Promise<void> {
  await importFilesAt(store, [file], world, {}, signal, projectRef)
}
