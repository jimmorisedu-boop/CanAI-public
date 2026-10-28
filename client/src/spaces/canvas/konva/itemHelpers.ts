import Konva from 'konva'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPromptChatDropResult, createPromptChatGroupDrop } from '../promptChatDrop'
import {
  notifyPromptChatDropHover,
  requestPromptChatDrop,
} from '../promptChatDropBus'
import { notifyArchiveHover } from '../archive/archiveBus'
import { getCompareSession, toggleCompareCandidate } from '../compare/compareBus'
import { archiveSelection, archiveTargets } from './archiveSelection'
import { computeAdaptiveTextDimensions, DEFAULT_FONT_SIZE } from './canvasLayout'
import type { CanvasStore } from './canvasStore'
import { applyResizeSnapGuides, applySnapGuides, clearGuides } from './snapGuides'
import type { CanvasItem } from './types'
import {
  GESTURE_FRAME_MS, beginGroupDrag, cancelGroupDrag, commitGroupDrag, groupDragFollowers, groupDragPositions, isGroupDragMember, moveGroupDrag, type GroupDragSession } from './groupDrag'
import { canPinCanvasItem } from './pinnableItem'
import { armLostDragEndSafety } from './dragEndSafety'
import { createGestureAdmission, type GestureAdmission } from './gestureAdmission'
import { cancelActiveDrag, clearActiveDrag, registerActiveDrag } from './activeDragLifecycle'
import { publishCanvasDrag } from './itemDragBus'
import { commitGestureWithLease } from './gestureCommit'
import {
  altKeyBelongsToCanvas, commitAltCopy, holdUncopied, isAltCopying, releaseAltCopy, syncAltCopy, wantsAltCopy,
} from './altDragCopy'
export { createGestureAdmission, type GestureAdmission } from './gestureAdmission'
export { stepTextTransform, type TextTransformState } from './textTransform'
import { stepTextTransform, type TextTransformState } from './textTransform'

// Фигуре нужен ТОЛЬКО масштаб — им держат минимальный экранный размер у
// полоски промпта и метки (см. LeftAccentStrip, MarkBadge).
//
// Раньше здесь стоял useCameraVersion, то есть подписка на ЛЮБОЕ движение
// камеры, и панорама перерисовывала каждую фигуру в кадре, хотя масштаб не
// менялся. React.memo от этого не спасает: он сравнивает пропсы, а подписка
// живёт внутри компонента. На доске из 600 картинок при отдалении это давало
// 246 мс на один сдвиг камеры — около четырёх кадров в секунду (замер
// 2026-08-08). Декорации теперь слушают отдельный канал, который уведомляет их
// только при переходе на следующую квантизованную ступень масштаба: обычный
// сдвиг камеры и промежуточные кадры wheel их вообще не будят.
export function useCameraScale(store: CanvasStore): number {
  return useSyncExternalStore(store.subscribeDecorationScale, store.getDecorationScale)
}

// Общие хелперы фигур канваса (drag/transform/тема/arrival).
// Вынесены из CanvasItems, чтобы Image/Video/Text/Pending жили отдельно.

export interface ItemProps {
  item: CanvasItem
  store: CanvasStore
  draggable: boolean
  selected?: boolean
}

export type KEvent = Konva.KonvaEventObject<MouseEvent>
type DragKEvent = KEvent | Konva.KonvaEventObject<DragEvent>
let groupDrag: GroupDragSession | null = null
let groupDragStore: CanvasStore | null = null
/**
 * Кого групповая фиксация уже записала.
 *
 * ⚠️ Konva Transformer тащит ВСЕ выделенные ноды и шлёт каждой свои
 * dragstart/dragend. Группу пишет первый же dragend — одним `updatePositions`,
 * одним шагом истории; остальные обязаны промолчать, иначе поверх общего
 * вектора лягут их личные координаты, снятые в разные мгновения жеста.
 */
let settledByGroupDrag: Set<string> = new Set()

interface PendingCanvasDrag {
  admission: GestureAdmission
  node: Konva.Node
  store: CanvasStore
  id: string
  movingIds: string[]
  origin: { x: number; y: number }
  admitted: boolean
  cancelled: boolean
}

const pendingCanvasDrags = new WeakMap<CanvasStore, PendingCanvasDrag>()

function restorePendingCanvasDrag(pending: PendingCanvasDrag): void {
  pending.node.position(pending.origin)
  pending.node.getLayer()?.batchDraw()
}

/** Cancel an awaiting desktop drag without affecting an already admitted one. */
export function cancelPendingCanvasDrag(store: CanvasStore): void {
  const pending = pendingCanvasDrags.get(store)
  if (!pending) return
  pending.cancelled = true
  pending.admission.cancel()
  restorePendingCanvasDrag(pending)
  // Keep the record until stopDrag has synchronously delivered dragend. The
  // handler uses `cancelled` to avoid treating that synthetic end as a commit.
  pending.node.stopDrag()
  pendingCanvasDrags.delete(store)
}

/** Blur/unmount отменяет и уже подтверждённый жест без записи в документ. */
export function cancelActiveCanvasDrag(store: CanvasStore): void {
  publishCanvasDrag(null)
  cancelPendingCanvasDrag(store)
  cancelActiveDrag(store)
}

function beginCanvasGroupDrag(store: CanvasStore, id: string, target: Konva.Node, alt: boolean): void {
  // ⚠️ У жеста ОДНА сессия. Transformer шлёт dragstart каждой выделенной ноде,
  // и раньше каждый такой вызов перезаписывал сессию: лидером оказывалась
  // последняя нода, условие `session.leader === e.target` в onDragEnd не
  // выполнялось ни для кого, и каждая нода писала себя сама — взаимные
  // расстояния разъезжались, а одно перетаскивание давало столько шагов
  // отмены, сколько объектов в выделении.
  if (groupDrag && groupDragStore === store) return
  const selected = store.getSelectedIds()
  const ids = new Set([...selected, id])
  const layer = target.getLayer()
  const nodes = layer
    ? [...ids].map((nodeId) => layer.find((node: Konva.Node) => node.id() === nodeId)[0]).filter((node): node is Konva.Node => Boolean(node))
    : [target]
  groupDrag = beginGroupDrag(store, id, nodes)
  groupDragStore = store
  // Страховка от потерянного dragEnd (нода размонтировалась кульингом посреди
  // переноса, drag оборван системой): сессия в модуле держала бы Konva-ноды и
  // позиции до следующего dragStart. Страховка слушает те же mouse/touch-end события,
  // что и Konva, и регистрируется позже него: при нормальном dragEnd сессия уже null.
  const session = groupDrag
  registerActiveDrag(store, () => {
    if (groupDrag !== session || groupDragStore !== store) return
    releaseAltCopy()
    cancelGroupDrag(session)
    store.getCollaboration()?.setPreview(null)
    ;(session.leader as Konva.Node).getLayer()?.batchDraw()
    groupDrag = null
    groupDragStore = null
  })
  armLostDragEndSafety(window, () => {
    if (groupDrag === session && groupDragStore === store) {
      // Потерянный dragend обязан закончить жест так же, как настоящий: шли с
      // копией — ставим копии, а не уводим исходники.
      const copying = isAltCopying(session)
      releaseAltCopy()
      if (copying) commitAltCopy(store, session)
      else commitGroupDrag(store, session)
      store.getCollaboration()?.setPreview(null)
      groupDrag = null
      groupDragStore = null
      clearActiveDrag(store)
    }
  }, () => cancelActiveCanvasDrag(store))
  // Alt нередко зажат ещё до нажатия мыши — тогда исходник остаётся на месте
  // с первого же кадра (см. altDragCopy).
  syncAltCopy(store, session, alt)
}

/** Зажат ли Alt в событии жеста. У программного startDrag события нет вовсе. */
function altHeld(e: DragKEvent): boolean {
  return Boolean((e.evt as { altKey?: boolean } | undefined)?.altKey)
}

function activeSession(store: CanvasStore): GroupDragSession | null {
  return groupDrag && groupDragStore === store ? groupDrag : null
}

/**
 * Alt нажали или отпустили посреди жеста, не двигая мышь: вид обязан
 * смениться сразу, а не на следующем движении. Заодно клавиша не уходит
 * браузеру (см. altKeyBelongsToCanvas).
 */
export function installAltCopyKeys(store: CanvasStore, target: Window = window): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Alt') return
    const session = activeSession(store)
    if (session) {
      const copying = syncAltCopy(store, session, event.type === 'keydown')
      if (copying) holdUncopied(store, session)
      else moveGroupDrag(session)
      ;(session.leader as Konva.Node).getLayer()?.batchDraw()
    }
    if (altKeyBelongsToCanvas(event.type === 'keydown' ? 'keydown' : 'keyup', Boolean(session))) {
      event.preventDefault()
    }
  }
  target.addEventListener('keydown', onKey)
  target.addEventListener('keyup', onKey)
  return () => {
    target.removeEventListener('keydown', onKey)
    target.removeEventListener('keyup', onKey)
  }
}

export function onCanvasItemDragStart(store: CanvasStore, id: string, e: DragKEvent): void {
  // Новый жест — прежний щит недействителен: если чей-то dragend потерялся
  // (нода размонтирована кульингом), его id не должен молчать вечно.
  if (!groupDrag) settledByGroupDrag = new Set()
  const selected = store.getSelectedIds()
  const movingIds = selected.has(id) && selected.size > 1 ? [...selected] : [id]
  const pending = pendingCanvasDrags.get(store)
  if (pending?.node === e.target) {
    if (pending.cancelled) {
      e.target.stopDrag()
      return
    }
    // The async request has just been granted. Konva emits dragstart again
    // from startDrag(); only now may the normal group session be created.
    if (pending.admitted) {
      pendingCanvasDrags.delete(store)
      beginCanvasGroupDrag(store, id, e.target, altHeld(e))
      return
    }
  }

  /**
   * ⚠️ Ждать аренду ПЕРЕД движением — это и есть «сетевая доска медленнее
   * локальной» (жалоба 08.09.2026). Аренда берётся у сервера команды, круг
   * занимает десятки миллисекунд, а на запасном пути больше, — и всё это
   * время объект не трогается с места, хотя палец уже поехал. На локальной
   * доске задержки нет вовсе.
   *
   * Свободный объект ведём СРАЗУ, а аренду берём параллельно: почти всегда
   * она приходит задолго до отпускания, и человек ничего не замечает. Если
   * откажут — вернём объект на место, ровно как и раньше
   * (restorePendingCanvasDrag), а в стор до отпускания всё равно ничего не
   * попадает: во время жеста двигается только нода Konva.
   *
   * ⚠️ Ждём по-прежнему там, где объект ДЕРЖИТ ЖИВОЙ КОЛЛЕГА (looksEditable
   * отвечает false): тащить чужое, чтобы через миг вернуть, — обман.
   */
  if (!store.canMutateItems(movingIds) && store.looksEditable(movingIds)) {
    // Аренду просим ПАРАЛЛЕЛЬНО движению. Отказ разбирать здесь не нужно:
    // onDragEnd и так проверяет право перед фиксацией и возвращает объект на
    // место, если его не дали. Обрывать жест на полпути хуже — рука ещё
    // ведёт объект, и он выскочил бы из-под пальца.
    void store.withSelection(movingIds, () => {})
    beginCanvasGroupDrag(store, id, e.target, altHeld(e))
    return
  }

  // Объект держит живой коллега: ждём ответа, не двигая его.
  if (!store.canMutateItems(movingIds)) {
    const admission = createGestureAdmission()
    const awaiting: PendingCanvasDrag = {
      admission,
      node: e.target,
      store,
      id,
      movingIds,
      origin: { x: e.target.x(), y: e.target.y() },
      admitted: false,
      cancelled: false,
    }
    pendingCanvasDrags.set(store, awaiting)
    restorePendingCanvasDrag(awaiting)
    e.target.stopDrag()
    admission.begin(
      () => store.withSelection(movingIds, () => {}),
      () => {
        if (pendingCanvasDrags.get(store) !== awaiting || awaiting.cancelled) return
        if (!store.canMutateItems(movingIds)) {
          awaiting.cancelled = true
          restorePendingCanvasDrag(awaiting)
          pendingCanvasDrags.delete(store)
          return
        }
        awaiting.admitted = true
        try {
          // Konva recalculates the pointer offset here, so the object remains
          // at its original position until the next actual pointer movement.
          e.target.startDrag()
          // Some Konva versions do not synchronously emit dragstart from an
          // imperative startDrag. Keep the fallback local and idempotent.
          if (pendingCanvasDrags.get(store) === awaiting) {
            pendingCanvasDrags.delete(store)
            beginCanvasGroupDrag(store, id, e.target, altHeld(e))
          }
        } catch {
          awaiting.cancelled = true
          awaiting.admission.cancel()
          restorePendingCanvasDrag(awaiting)
          pendingCanvasDrags.delete(store)
        }
      },
      () => {
        if (pendingCanvasDrags.get(store) !== awaiting) return
        restorePendingCanvasDrag(awaiting)
        pendingCanvasDrags.delete(store)
      },
    )
    return
  }
  beginCanvasGroupDrag(store, id, e.target, altHeld(e))
}

export function selectOnClick(store: CanvasStore, id: string, e: KEvent): void {
  e.cancelBubble = true // не даём клику дойти до сцены (там снимается выделение)
  if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return
  // в режиме набора сравнения клик означает «добавить/убрать из сравнения», а
  // не «сделать референсом» — иначе набор ломал бы промпт-бар
  const session = getCompareSession()
  if (session?.phase === 'picking') {
    toggleCompareCandidate(id)
    return
  }
  store.select(id, e.evt.shiftKey)
}

// Отпустили объект над слотом полки ассетов? Тогда закрепляем его туда и
// возвращаем на место (перенос = «скопировать в быстрый доступ», холст цел).
export function tryPinToAssetBar(
  store: CanvasStore,
  item: CanvasItem,
  clientX: number,
  clientY: number,
): boolean {
  if (!canPinCanvasItem(item) || item.kind === 'link') return false
  const el = document.elementFromPoint(clientX, clientY)?.closest('[data-asset-slot]')
  if (!el) return false
  const slot = Number((el as HTMLElement).dataset.assetSlot)
  if (!Number.isInteger(slot)) return false
  store.pinAsset({
    slot,
    kind: item.kind,
    src: item.src,
    assetId: item.assetId,
    mime: item.mime,
    text: item.text,
    name: item.name,
    width: item.naturalWidth ?? item.w,
    height: item.naturalHeight ?? item.h,
  })
  return true
}

function clientPoint(e: DragKEvent): { x: number; y: number } | null {
  // On an HTML overlay the Stage pointer can be stale or already cleared.
  // Hit-test the release itself, including touchend's changedTouches.
  const event = e.evt as MouseEvent | TouchEvent | undefined
  const touch = event && 'changedTouches' in event ? event.changedTouches[0] : undefined
  const pointerEvent = touch ?? (event && 'clientX' in event ? event : null)
  if (pointerEvent) return { x: pointerEvent.clientX, y: pointerEvent.clientY }
  const stage = e.target.getStage()
  const pointer = stage?.getPointerPosition()
  const rect = stage?.container().getBoundingClientRect()
  return pointer && rect
    ? { x: rect.left + pointer.x, y: rect.top + pointer.y }
    : null
}

function overPromptChat(point: { x: number; y: number }): boolean {
  return Boolean(
    document
      .elementFromPoint(point.x, point.y)
      ?.closest('[data-prompt-chat-dropzone]'),
  )
}

function overArchive(point: { x: number; y: number }): boolean {
  return Boolean(
    document.elementFromPoint(point.x, point.y)?.closest('[data-archive-dropzone]'),
  )
}

// Отпустили объект над плиткой «Архив» — материал уезжает с холста в архив
// доски. Если тащили один из ВЫДЕЛЕННЫХ объектов, уезжает всё выделение
// («выделили и перенесли кучу файлов»), иначе — только этот объект.
export function tryArchiveDrop(
  store: CanvasStore,
  item: CanvasItem,
  clientX: number,
  clientY: number,
): boolean {
  if (!overArchive({ x: clientX, y: clientY })) return false
  return archiveSelection(store, archiveTargets(store, item.id)) > 0
}

export function onCanvasItemDragMove(
  store: CanvasStore,
  id: string,
  e: DragKEvent,
): void {
  const pending = pendingCanvasDrags.get(store)
  if (pending?.node === e.target && !pending.admitted) {
    restorePendingCanvasDrag(pending)
    return
  }
  // Alt можно зажать и отпустить по дороге — вид следует за клавишей.
  const active = activeSession(store)
  const copying = active ? syncAltCopy(store, active, altHeld(e)) : false
  applySnapGuides(store, id, e.target, { ownPlaces: copying })
  if (groupDrag?.leader === e.target) moveGroupDrag(groupDrag)
  if (copying && active) holdUncopied(store, active)
  // С копией исходники никуда не едут — коллегам показывать нечего.
  if (groupDrag?.leader === e.target && !copying) {
    // ⚠️ Кадр жеста собирается из запомненного при захвате и уходит не чаще,
    // чем сервер его принимает: см. GESTURE_FRAME_MS и DragOrigin.
    const session = groupDrag
    const now = Date.now()
    if (now - session.previewSentAt >= GESTURE_FRAME_MS) {
      session.previewSentAt = now
      const dx = e.target.x() - session.leaderX
      const dy = e.target.y() - session.leaderY
      store.getCollaboration()?.setPreview(session.origins.map((origin) => ({
        id: origin.id, x: origin.x + dx, y: origin.y + dy,
        w: origin.w, h: origin.h, rotation: origin.rotation,
      })))
    }
  }
  publishDragOffset(store, id, e.target)
  const point = clientPoint(e)
  const drop = createPromptChatDropResult(store.getItem(id))
  notifyPromptChatDropHover(
    Boolean(
      point
      && overPromptChat(point)
      && drop?.event.kind === 'reference',
    ),
  )
  // С Alt исходник не трогаем вовсе — значит и плитка архива его не зовёт.
  notifyArchiveHover(Boolean(!copying && point && store.getItem(id) && overArchive(point)))
}

/**
 * Сказать HTML-панелям над холстом, куда уехал объект.
 *
 * Стор во время жеста не трогаем (иначе каждый кадр стал бы шагом отмены),
 * поэтому панель над объектом узнаёт о переезде только отсюда.
 */
function publishDragOffset(store: CanvasStore, id: string, node: Konva.Node): void {
  const origin = store.getItem(id) ?? store.getPending().find((candidate) => candidate.id === id)
  if (!origin) return
  const selected = store.getSelectedIds()
  const ids = selected.has(id) && selected.size > 1 ? [...selected] : [id]
  publishCanvasDrag({ ids, dx: node.x() - origin.x, dy: node.y() - origin.y })
}

export function onDragEnd(
  store: CanvasStore,
  id: string,
  e: DragKEvent,
): void {
  // Жест окончен при любом исходе — панель снова считает место по стору.
  publishCanvasDrag(null)
  // Группу уже записал dragend соседней ноды — этот приходит вторым и писать
  // ему нечего (см. settledByGroupDrag).
  if (settledByGroupDrag.delete(id)) return
  const pendingAdmission = pendingCanvasDrags.get(store)
  if (pendingAdmission?.node === e.target && !pendingAdmission.admitted) {
    restorePendingCanvasDrag(pendingAdmission)
    if (pendingAdmission.cancelled) pendingCanvasDrags.delete(store)
    return
  }
  clearGuides(store)
  notifyPromptChatDropHover(false)
  notifyArchiveHover(false)
  const item = store.getItem(id)
  const pending = store.getPending().find((candidate) => candidate.id === id)
  const selected = store.getSelectedIds()
  const movingIds = selected.has(id) && selected.size > 1 ? [...selected] : [id]
  const session = groupDrag
  // Копия или перенос — решает Alt в миг отпускания (см. altDragCopy).
  // Призраки убираем при любом исходе: дальше ветки расходятся.
  const copying = Boolean(session) && isGroupDragMember(session!, id) && wantsAltCopy(store, session!, altHeld(e))
  releaseAltCopy()
  const revert = (): void => {
    if (session) cancelGroupDrag(session)
    else if (item) e.target.position({ x: item.x, y: item.y })
    else if (pending) e.target.position({ x: pending.x, y: pending.y })
    e.target.getLayer()?.batchDraw()
  }
  const point = clientPoint(e)
  if (point && overPromptChat(point)) {
    // Attaching references does not mutate the board or need an edit lease.
    // Deliver the frozen group once: Transformer need not emit every dragend.
    const group = session && isGroupDragMember(session, id) ? session : null
    const ids = group ? group.origins.map((origin) => origin.id) : movingIds
    const event = createPromptChatGroupDrop(store, ids)
    if (event && requestPromptChatDrop(event)) {
      if (group) settledByGroupDrag = new Set(groupDragFollowers(group, id))
      revert()
      groupDrag = null
      groupDragStore = null
      clearActiveDrag(store)
      store.getCollaboration()?.setPreview(null)
      return
    }
  }
  // ⚠️ Объект, который держит ЖИВОЙ коллега, возвращаем сразу: ждать нечего.
  // Всё остальное доводится до холста, добрав аренду по дороге, — см.
  // commitGestureWithLease. Прежний общий отказ по canMutateItems откатывал
  // и обычный перенос: аренду просят параллельно жесту, и к отпусканию она
  // почти никогда не успевает.
  if (!store.looksEditable(movingIds)) {
    revert()
    store.getCollaboration()?.setPreview(null)
    groupDrag = null
    groupDragStore = null
    clearActiveDrag(store)
    return
  }
  // ⚠️ С Alt исходник остаётся на доске при любом исходе: копию, отпущенную
  // над плиткой архива, просто ставим на холст, а в архив ничего не увозим.
  if (!copying && item && point && overArchive(point)) {
    // объект уехал с холста — возвращать ноду на место не нужно, её уже нет
    groupDrag = null
    groupDragStore = null
    clearActiveDrag(store)
    store.getCollaboration()?.setPreview(null)
    commitGestureWithLease(
      store,
      movingIds,
      () => { archiveSelection(store, archiveTargets(store, item.id)) },
      revert,
    )
    return
  }
  if (item && point && tryPinToAssetBar(store, item, point.x, point.y)) {
    // вернуть объект на исходную позицию — он не «переехал», а закреплён
    if (groupDrag) cancelGroupDrag(groupDrag)
    else e.target.position({ x: item.x, y: item.y })
    groupDrag = null
    groupDragStore = null
    clearActiveDrag(store)
    store.getCollaboration()?.setPreview(null)
    e.target.getLayer()?.batchDraw()
    return
  }
  if (copying && session) {
    // Исходники остаются где были, копии встают туда, куда их привели, —
    // одной правкой. Аренда не нужна: чужого мы не трогаем, только добавляем.
    settledByGroupDrag = new Set(groupDragFollowers(session, id))
    groupDrag = null
    groupDragStore = null
    clearActiveDrag(store)
    store.getCollaboration()?.setPreview(null)
    commitAltCopy(store, session)
    return
  }
  // Координаты снимаем СЕЙЧАС: пока едет аренда, culling или перерисовка
  // могут вернуть ноду на прежнее место, и запись ушла бы не туда.
  const dropped = { x: e.target.x(), y: e.target.y() }
  // Пишет группу тот dragend, что пришёл первым, — лидером он быть не обязан:
  // Transformer ведёт все ноды одним вектором, и порядок событий не наш.
  const groupPositions = session && isGroupDragMember(session, id)
    ? groupDragPositions(session)
    : null
  if (groupPositions && session) settledByGroupDrag = new Set(groupDragFollowers(session, id))
  const commit = groupPositions
    ? () => store.updatePositions(groupPositions)
    : item
      ? () => store.updateItem(id, dropped)
      : pending
        ? () => store.updatePending(id, dropped)
        : null
  groupDrag = null
  groupDragStore = null
  clearActiveDrag(store)
  store.getCollaboration()?.setPreview(null)
  if (commit) commitGestureWithLease(store, movingIds, commit, revert)
}

// пересчёт scale трансформера в ширину/высоту. Базовый размер берём из СТОРА
// (item.w/h), а не node.width()/height(): у Konva.Image это то же самое, а у
// текста (Group без явных width/height) node.width() вернул бы 0 — тогда
// после ресайза текстовая карточка ужалась бы в точку.
export function onTransformEnd(store: CanvasStore, id: string, node: Konva.Node): void {
  store.getCollaboration()?.setPreview(null)
  clearGuides(store)
  const item = store.getItem(id)
  const scaleX = node.scaleX()
  const scaleY = node.scaleY()
  node.scaleX(1)
  node.scaleY(1)
  const selected = store.getSelectedIds()
  const movingIds = selected.has(id) && selected.size > 1 ? [...selected] : [id]
  const current = item ?? store.getPending().find((candidate) => candidate.id === id)
  const revert = (): void => {
    if (current) node.position({ x: current.x, y: current.y })
    node.getLayer()?.batchDraw()
  }
  // Геометрию снимаем СЕЙЧАС — запись бывает отложенной, см. commitGestureWithLease.
  const box = { x: node.x(), y: node.y(), rotation: node.rotation() }
  if (item) {
    queueTransformCommit(store, {
      id,
      patch: { ...box, w: Math.max(20, item.w * scaleX), h: Math.max(20, item.h * scaleY) },
      revert,
    })
    return
  }
  if (current) {
    commitGestureWithLease(store, movingIds, () => store.updatePending(id, {
      x: box.x,
      y: box.y,
      w: Math.max(40, Math.round(current.w * scaleX)),
      h: Math.max(40, Math.round(current.h * scaleY)),
    }), revert)
  }
}

interface TransformCommit {
  id: string
  patch: Partial<CanvasItem>
  revert: () => void
}

const transformBatches = new WeakMap<CanvasStore, TransformCommit[]>()

/**
 * Завершения одного жеста изменения размера — ОДНОЙ правкой.
 *
 * ⚠️ Трансформер завершает жест по объекту за раз (у каждого свой
 * `transformend`), и каждый объект уходил своим `updateItem`: изменение
 * размера группы давало по шагу отмены на объект — и на своей доске, и на
 * сетевой (находка С-3 аудита 24.09.2026). Завершения одного жеста приходят
 * подряд в одном такте, поэтому копим их до ближайшей микрозадачи.
 */
function queueTransformCommit(store: CanvasStore, commit: TransformCommit): void {
  const queued = transformBatches.get(store)
  if (queued) {
    queued.push(commit)
    return
  }
  const batch = [commit]
  transformBatches.set(store, batch)
  queueMicrotask(() => {
    transformBatches.delete(store)
    commitGestureWithLease(
      store,
      batch.map(({ id }) => id),
      () => store.updateItems(batch.map(({ id, patch }) => ({ id, patch }))),
      () => batch.forEach((entry) => entry.revert()),
    )
  })
}

/**
 * Прилипание краёв во время изменения размера — правит саму ноду на кадре.
 *
 * Размер здесь задан масштабом (`scaleX/scaleY` × размер из стора), поэтому
 * прилипание возвращается тем же масштабом: пересчёт в w/h делает уже
 * `onTransformEnd`, и второго источника правды не появляется.
 */
function snapTransform(store: CanvasStore, id: string, node: Konva.Node): void {
  const source = store.getItem(id) ?? store.getPending().find((candidate) => candidate.id === id)
  if (!source || source.w <= 0 || source.h <= 0) return
  // Повёрнутый объект пропускаем: у него экранная рамка не совпадает с
  // прямоугольником, по которому считаются направляющие.
  if (node.rotation()) return
  const snapped = applyResizeSnapGuides(store, id, {
    x: node.x(),
    y: node.y(),
    w: source.w * node.scaleX(),
    h: source.h * node.scaleY(),
  }, true)
  node.position({ x: snapped.x, y: snapped.y })
  node.scaleX(snapped.w / source.w)
  node.scaleY(snapped.h / source.h)
}

/** Когда у доски последний раз ушёл кадр изменения размера — см. onTransformPreview. */
const transformPreviewSentAt = new WeakMap<CanvasStore, number>()

export function onTransformPreview(
  store: CanvasStore,
  id: string,
  node: Konva.Node,
  dimensions?: { w: number; h: number },
): void {
  const selected = store.getSelectedIds()
  const movingIds = selected.has(id) && selected.size > 1 ? [...selected] : [id]
  if (!store.canMutateItems(movingIds)) {
    store.getCollaboration()?.setPreview(null)
    return
  }
  // ⚠️ Смарт-гайды при изменении размера — только у ОДНОГО объекта и только
  // там, где размер задан масштабом ноды. У пачки Transformer тянет общую
  // рамку и раскладывает её сам, а у текста (dimensions) размеры уже
  // пересчитаны своей моделью с перетеканием строк — вмешиваться туда значит
  // ломать то и другое.
  if (movingIds.length === 1 && !dimensions) snapTransform(store, id, node)
  // ⚠️ Transformer шлёт `transform` КАЖДОЙ ноде группы на каждое движение
  // мыши, и раньше каждая из них собирала кадр всей группы и отправляла его
  // коллегам: 10 объектов — около 600 сообщений в секунду, а сервер команды
  // рвёт соединение после 3000 в минуту, то есть через пять секунд тяги.
  // Считалось это ещё и поиском по всей доске на каждый объект — до 0,76 с на
  // движение мыши при сотне объектов, и на ЛОКАЛЬНОЙ доске тоже, где слать
  // кадры вообще некому (находка П-7 аудита 24.09.2026). Теперь кадр один на
  // группу и не чаще, чем у переноса (GESTURE_FRAME_MS), а без коллег его не
  // собираем вовсе.
  const collaboration = store.getCollaboration()
  if (!collaboration) return
  const now = Date.now()
  if (now - (transformPreviewSentAt.get(store) ?? 0) < GESTURE_FRAME_MS) return
  transformPreviewSentAt.set(store, now)
  const layer = node.getLayer()
  const others = new Set(movingIds.filter((objectId) => objectId !== id))
  const nodes = new Map<string, Konva.Node>([[id, node]])
  if (layer && others.size > 0) {
    // Один обход слоя на всю группу, а не по обходу на каждый объект.
    for (const candidate of layer.find((found: Konva.Node) => others.has(found.id()))) {
      if (!nodes.has(candidate.id())) nodes.set(candidate.id(), candidate)
    }
  }
  const geometries = movingIds.flatMap((objectId) => {
    const source = store.getItem(objectId) ?? store.getPending().find((candidate) => candidate.id === objectId)
    if (!source) return []
    const target = nodes.get(objectId)
    if (!target) return []
    return [{
      id: objectId,
      x: target.x(),
      y: target.y(),
      w: objectId === id && dimensions ? dimensions.w : Math.max(1, source.w * target.scaleX()),
      h: objectId === id && dimensions ? dimensions.h : Math.max(1, source.h * target.scaleY()),
      rotation: target.rotation(),
    }]
  })
  if (geometries.length > 0) collaboration.setPreview(geometries)
}

// Фиксация результата в сторе — ровно один шаг истории на всю трансформацию.
export function commitTextTransform(
  store: CanvasStore,
  id: string,
  node: Konva.Node,
  state: TextTransformState | null,
): void {
  const item = store.getItem(id)
  if (!item) return
  store.getCollaboration()?.setPreview(null)
  // state пуст, если transform не успел сработать ни разу (клик без движения)
  const final =
    state ??
    stepTextTransform({ w: item.w, h: item.h, fontSize: item.fontSize ?? DEFAULT_FONT_SIZE }, node, item.text)
  const box = { x: node.x(), y: node.y(), rotation: node.rotation() }
  commitGestureWithLease(
    store,
    [id],
    () => store.updateItem(id, {
      ...box,
      w: final.w,
      h: final.h,
      fontSize: Math.round(final.fontSize * 10) / 10,
    }),
    () => {
      node.position({ x: item.x, y: item.y })
      node.scaleX(1)
      node.scaleY(1)
      node.getLayer()?.batchDraw()
    },
  )
}

// Читаем CSS-переменные из :root — цвета адаптируются к теме
export function useThemeColors() {
  const [colors, setColors] = useState(() => resolveThemeColors())
  useEffect(() => {
    // пересчитываем при смене атрибута data-theme на :root
    const observer = new MutationObserver(() => setColors(resolveThemeColors()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return colors
}

export function resolveThemeColors() {
  const s = getComputedStyle(document.documentElement)
  const get = (v: string) => s.getPropertyValue(v).trim()
  return {
    pendingFill: get('--surface-2') || '#16181d',
    pendingStroke: get('--border-strong') || 'rgba(255,255,255,0.16)',
    errorFill: get('--danger-soft') || 'rgba(255,107,80,0.1)',
    errorStroke: get('--danger') || '#ff6b50',
    errorText: get('--danger') || '#ff6b50',
    labelColor: get('--text-2') || '#9ea3ae',
    timerColor: get('--text-3') || '#626772',
    spinnerColor: get('--accent') || '#d33f21',
    // Акцент берём из токенов, а не зашиваем: раньше карточка ссылки жила
    // на старом оранжевом #ff6038 и выбивалась из палитры всего остального.
    accent: get('--accent') || '#d33f21',
    accentHover: get('--accent-hover') || '#bd3518',
    accentSoft: get('--accent-soft') || 'rgba(211,63,33,0.16)',
    dismissBg: get('--surface-solid') || '#121316',
    dismissBorder: get('--border') || 'rgba(255,255,255,0.08)',
    itemBorder: get('--border-strong') || 'rgba(255,255,255,0.16)',
    textBg: get('--surface') || '#ffffff',
    textBorder: get('--border-strong') || '#e7e4de',
    textColor: get('--text') || '#1a1a1f',
    textOverflowMuted: get('--text-3') || '#626772',
    textOverflowAccent: get('--accent') || '#d33f21',
  }
}

// «Приземление» свежесгенерированного объекта: короткое материализующее появление
// без декоративного отскока (импульса пользователя здесь нет). Уважает reduced-motion.
export function useArrival(store: CanvasStore, id: string, node: () => Konva.Node | null, ready: boolean) {
  useEffect(() => {
    if (!ready) return
    // Сначала нода, потом takeFresh: флаг «свежести» одноразовый, и если ref
    // ещё не встал, он сгорал зря — анимация не доигрывалась уже никогда.
    const n = node()
    if (!n) return
    if (!store.takeFresh(id)) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    n.opacity(0)
    n.scale({ x: 0.96, y: 0.96 })
    const tw = new Konva.Tween({
      node: n,
      opacity: 1,
      scaleX: 1,
      scaleY: 1,
      duration: 0.28,
      easing: Konva.Easings.EaseOut,
    })
    tw.play()
    return () => {
      tw.destroy()
      n.opacity(1)
      n.scale({ x: 1, y: 1 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
}

// Кэш размеров файлов, чтобы не делать HEAD-запрос при каждом ховере.
// Ограничен как LRU: строки короткие, но досок за сеанс открывают много.
const FILE_SIZE_CACHE_LIMIT = 500
const fileSizeCache = new Map<string, string>()

function rememberFileSize(src: string, formatted: string): void {
  fileSizeCache.delete(src)
  if (fileSizeCache.size >= FILE_SIZE_CACHE_LIMIT) {
    const oldest = fileSizeCache.keys().next().value
    if (oldest !== undefined) fileSizeCache.delete(oldest)
  }
  fileSizeCache.set(src, formatted)
}

function cachedFileSize(src: string): string | undefined {
  const value = fileSizeCache.get(src)
  if (value !== undefined) {
    fileSizeCache.delete(src)
    fileSizeCache.set(src, value)
  }
  return value
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const val = bytes / Math.pow(k, i)
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${sizes[i]}`
}

// Вес файла для бейджа под курсором.
//
// `enabled` не роскошь: бейдж виден ТОЛЬКО при наведении, то есть максимум у
// одного объекта, а HEAD-запрос уходил у каждого объекта в кадре. На доске,
// раскрытой целиком, это триста запросов ради подписи, которую никто не
// смотрит (замер 2026-08-09: 1176 обращений к media на 300 картинок, ровно
// половина — HEAD без тела). Ответы кэшируются на модуль, поэтому со второго
// наведения размер появляется мгновенно.
export function useMediaSize(src?: string, enabled = true): string | null {
  const [size, setSize] = useState<string | null>(() => (src ? cachedFileSize(src) ?? null : null))

  useEffect(() => {
    if (!src || !enabled) return
    const cached = cachedFileSize(src)
    if (cached !== undefined) {
      setSize(cached)
      return
    }
    let active = true
    // ⚠️ Мышь ушла — размер больше никому не нужен, и запрос отменяется: не
    // отменённый, он держал одно из шести соединений браузера к приложению, а
    // за ним в очереди стояли проверка связи и запуск генерации (находка Ф-1
    // аудита сетевой доски 24.09.2026).
    const controller = new AbortController()
    fetch(src, { method: 'HEAD', signal: controller.signal })
      .then((res) => {
        if (!active) return
        const len = res.headers.get('content-length')
        if (len) {
          const bytes = parseInt(len, 10)
          if (!isNaN(bytes)) {
            const formatted = formatBytes(bytes)
            rememberFileSize(src, formatted)
            setSize(formatted)
          }
        }
      })
      .catch(() => {})
    return () => {
      active = false
      controller.abort()
    }
  }, [src, enabled])

  return size
}

let canvasEl: HTMLCanvasElement | null = null
export function measureTextWidth(text: string, font: string): number {
  if (!canvasEl) {
    canvasEl = document.createElement('canvas')
  }
  const context = canvasEl.getContext('2d')
  if (context) {
    context.font = font
    return context.measureText(text).width
  }
  return text.length * 6.5
}
