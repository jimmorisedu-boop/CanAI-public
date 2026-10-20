import type { CanvasStore } from './canvasStore'
import type { CanvasItem, Placeholder } from './types'
import type { ProjectRef } from '../../../types'
import { adoptPastedItem, needsAdoption, type MediaAdopter } from './pasteAdoption'
import { registerCardRetry } from './transientCardRetry'

/**
 * Вставка, у которой файлы должны сперва переехать на доску назначения.
 *
 * ⚠️ Раньше такая вставка молчала, пока не переедут ВСЕ файлы, по одному, а
 * потом клала всё разом — или не клала ничего: 10 картинок при 1 МБ/с — около
 * 42 секунд тишины, и один сорвавшийся файл отменял остальные девять (находка
 * Ф-7 аудита сетевой доски 24.09.2026). Теперь как у импорта файлов: на месте
 * каждого объекта сразу стоит карточка с ходом переноса, файлы едут по
 * нескольку одновременно, и каждый объект встаёт на доску, как только готов
 * его файл. Не переехал — его карточка краснеет с причиной и «Повторить»,
 * остальные на месте.
 *
 * Объекты без переезда (текст, свои файлы доски) встают сразу, одним шагом.
 */

/** Сколько файлов вставки едет одновременно: больше — уже спорит с доской за сеть. */
export const PASTE_PARALLEL = 3

export type PasteStore = Pick<CanvasStore,
  | 'layoutPaste'
  | 'insertPasted'
  | 'addTransientUploadPending'
  | 'updatePending'
  | 'failPendingById'
  | 'dismissPendingById'
  | 'getPending'
  | 'getSelection'
  | 'setSelection'
>

export interface PasteFlow {
  destination: ProjectRef | null
  /** С какой доски скопировано — файл другой сетевой доски копируется к этой. */
  origin: ProjectRef | null
  adopt: MediaAdopter
}

export interface PasteOutcome {
  /** Что встало на доску — сразу или по готовности файла, в порядке группы. */
  placed: string[]
  /** Имена тех, чьи файлы не переехали: их карточки остались на доске. */
  failed: string[]
}

export async function pasteWithCards(
  store: PasteStore,
  items: CanvasItem[],
  targetWorld: { x: number; y: number } | undefined,
  viewportSize: { w: number; h: number } | undefined,
  flow: PasteFlow,
): Promise<PasteOutcome> {
  const copies = store.layoutPaste(items, targetWorld, viewportSize)
  const moving = copies.filter((copy) => needsAdoption(copy, flow.destination, flow.origin))
  const movingIds = new Set(moving.map((copy) => copy.id))
  const ready = store.insertPasted(copies.filter((copy) => !movingIds.has(copy.id)))
  if (moving.length === 0) return { placed: ready, failed: [] }

  const selectionAtStart = store.getSelection()
  const cards = moving.map((copy) => ({
    copy,
    cardId: store.addTransientUploadPending(
      { x: copy.x, y: copy.y, w: copy.w, h: copy.h },
      copy.kind as Placeholder['kind'],
      `Transferring ${copy.name || 'file'}`,
    ),
  }))
  const arrived = new Set(ready)
  const failed: string[] = []
  await inParallel(cards, PASTE_PARALLEL, async ({ copy, cardId }) => {
    try {
      const id = await moveToBoard(store, cardId, copy, flow)
      if (id) arrived.add(id)
    } catch {
      failed.push(copy.name || 'file')
    }
  })
  const placed = copies.map((copy) => copy.id).filter((id) => arrived.has(id))
  // Выделение забираем, только если человек его за это время не трогал:
  // перенос долгий, и он вправе заняться другим.
  if (placed.length > 0 && sameIds(store.getSelection(), selectionAtStart)) store.setSelection(placed)
  return { placed, failed }
}

/**
 * Переселить файл одного объекта и поставить объект на место его карточки.
 *
 * ⚠️ Карточку могли подвинуть — объект встаёт туда, где она сейчас. Карточку
 * могли убрать — объект не воскрешаем: человек сказал, что он не нужен.
 */
async function moveToBoard(
  store: PasteStore,
  cardId: string,
  copy: CanvasItem,
  flow: PasteFlow,
): Promise<string | null> {
  try {
    const adopted = await adoptPastedItem(copy, flow.adopt, flow.destination, flow.origin, {
      onProgress: (loaded, total) => {
        if (total <= 0) return
        const percent = Math.min(100, Math.round((loaded / total) * 100))
        store.updatePending(cardId, { stage: `Transferring · ${percent}%` }, { system: true })
      },
    })
    const card = store.getPending().find((pending) => pending.id === cardId)
    if (!card) return null
    store.dismissPendingById(cardId)
    const [id] = store.insertPasted([{ ...adopted, x: card.x, y: card.y, w: card.w, h: card.h }], { select: false })
    return id ?? null
  } catch (error) {
    if (store.getPending().some((pending) => pending.id === cardId)) {
      registerCardRetry(cardId, () => {
        store.updatePending(cardId, {
          status: 'loading', error: undefined, stage: undefined, startedAt: Date.now(),
        }, { system: true })
        void moveToBoard(store, cardId, copy, flow).catch(() => undefined)
      })
      store.failPendingById(cardId, error instanceof Error && error.message ? error.message : 'Failed to transfer file')
    }
    throw error
  }
}

async function inParallel<T>(list: T[], limit: number, work: (entry: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < list.length) await work(list[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((id) => set.has(id))
}
