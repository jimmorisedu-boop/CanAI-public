// Правила полки кадров, которым не нужен React: что вернуть вызывающему после
// «снять кадр» и какой кадр выбран. Хук useFrameCapture только держит состояние
// и зовёт эти функции, поэтому правила проверяются без DOM.

import type { FrameCaptureRecord } from './frameCaptureQueue'

/**
 * Исход «снять кадр»: поставили в очередь или такой кадр уже есть. Вызывающему
 * важна разница — на дубле ничего нового не появилось, но запись, к которой он
 * привёл, существует, и её надо показать.
 */
export type CaptureOutcome = { kind: 'queued' | 'duplicate'; record: FrameCaptureRecord }

export function captureOutcome(result: { record: FrameCaptureRecord; duplicate: boolean }): CaptureOutcome {
  return { kind: result.duplicate ? 'duplicate' : 'queued', record: result.record }
}

/**
 * Выбор кадра хранится вместе с очередью, к которой относится. Новый клип —
 * новая очередь, и выбор прошлого клипа к ней не липнет: сравнение идёт по
 * самой очереди, а не по id (id записей в разных очередях могут совпасть).
 */
export interface FrameSelection {
  owner: unknown
  id: string | null
}

export const NO_SELECTION: FrameSelection = { owner: null, id: null }

/** Кадр, который сняли только что, выбирается; дубль выбирает уже существующую запись. */
export function selectionAfterCapture(owner: unknown, outcome: CaptureOutcome): FrameSelection {
  return { owner, id: outcome.record.id }
}

/** Выбор вручную (в том числе снятие выбора: id = null). */
export function selectionOf(owner: unknown, id: string | null): FrameSelection {
  return { owner, id }
}

/**
 * Выбранный кадр для показа. Выбор действителен, только пока та же очередь и
 * запись ещё на полке: убрали кадр (`drop`) — выбор снимается сам, ничего
 * отдельно чистить не надо.
 */
export function selectedFrameId(
  selection: FrameSelection,
  owner: unknown,
  records: readonly Pick<FrameCaptureRecord, 'id'>[],
): string | null {
  if (selection.id === null || selection.owner !== owner) return null
  return records.some((record) => record.id === selection.id) ? selection.id : null
}
