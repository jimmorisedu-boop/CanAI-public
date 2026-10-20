import type { CanvasStore } from './canvasStore'
import { showErrorToast } from '../toastBus'

// Действия холста, которым нужна аренда объекта.
//
// ⚠️ **Аренда — доказательство единоличной правки, а не право писать.** Право
// проверено раньше, при открытии сессии; аренда лишь разводит двоих, взявшихся
// за один объект. Значит действие обязано БРАТЬ её само, а не отказывать тому,
// у кого её сейчас нет: на локальной доске «Удалить» работает всегда, и
// сетевая не имеет права вести себя иначе.
//
// ⚠️ Без этого кнопки молча умирали, и заметить это было нельзя. Аренда живёт
// 20 секунд и продлевается раз в 5, но продление теряется от любой мелочи —
// притормозившая вкладка, смена канала до сервера команды, отброшенный кадр.
// Когда она истекала, `expireOwned` просто забывал объект, и НИКТО её не
// перезапрашивал: выделение при этом оставалось на месте (рамка, ручки,
// панель — это вид, см. looksMutable), а `canMutateItems` отвечал «нет».
// Человек видел выделенную картинку, жал Delete и «Удалить» в меню — и не
// происходило ничего (жалоба 09.09.2026 «почему я не могу удалить на сетевой
// доске»). Перетаскивание при этом работало: там аренда бралась на месте
// (`itemHelpers`) — этот же приём теперь общий на все действия.
//
// ⚠️ Отказ объясняем СЛОВАМИ: молчащая кнопка хуже отказа, потому что о ней
// нечего даже спросить.

export const PENDING_LEASE_REFUSED = 'Someone else is editing this card'
export const LEASE_REFUSED = 'Someone else is editing this object'

/**
 * Взять аренду на объекты и выполнить действие.
 *
 * Возвращает `false`, если аренду не дали, — вызывающий обязан сказать об
 * этом человеку.
 */
export async function withBoardLease(
  store: Pick<CanvasStore, 'withSelection'>,
  ids: string | readonly string[],
  work: () => void | Promise<void>,
): Promise<boolean> {
  return store.withSelection(typeof ids === 'string' ? [ids] : [...ids], work)
}

/**
 * То же, но без ожидания: отказ сам уходит сообщением.
 *
 * ⚠️ Когда аренда УЖЕ есть — а на локальной доске она не нужна вовсе — работа
 * идёт СИНХРОННО, как и раньше. Иначе Delete превращался бы в отложенное
 * действие на всех досках сразу, а история отмены — в гонку с микрозадачами.
 * Круг до сервера остаётся только там, где аренду и правда надо взять.
 */
export function runWithBoardLease(
  store: Pick<CanvasStore, 'withSelection' | 'canMutateItems'>,
  ids: string | readonly string[],
  work: () => void | Promise<void>,
  refused: string = LEASE_REFUSED,
): void {
  const list = typeof ids === 'string' ? [ids] : [...ids]
  if (store.canMutateItems(list)) {
    void work()
    return
  }
  void withBoardLease(store, list, work).then((admitted) => {
    if (!admitted) showErrorToast(refused)
  })
}
