import type Konva from 'konva'
import type { CanvasStore } from './canvasStore'
import { cancelGroupDrag, type GroupDragSession } from './groupDrag'

/**
 * Перенос с зажатым Alt кладёт КОПИЮ, а исходник оставляет на месте — как в
 * Figma и Photoshop (просьба 01.10.2026: «нужно чтобы контент копировался с
 * зажатой клавишей альт»).
 *
 * ⚠️ Решает Alt В МИГ ОТПУСКАНИЯ мыши, а не в начале жеста: его можно зажать
 * уже по дороге и отпустить, передумав. Пока он зажат, исходники видны на
 * своих местах «призраками». Без них не обойтись: стор во время жеста молчит
 * (иначе каждый кадр стал бы шагом отмены), едет сама нода Konva — и человек
 * видел бы обычный перенос, а копию только после отпускания.
 *
 * ⚠️ Запись ОДНА: копии встают одной правкой и одним шагом отмены, исходников
 * стор не касается вовсе. Поэтому и на сетевой доске коллеги не видят «уехал
 * — вернулся»: кадры жеста на время копирования не шлём.
 *
 * Модуль не тянет Konva в рантайме (только типы): правила проверяются тестами
 * на простых подставках, а `itemHelpers` остаётся обвязкой.
 */

/** Имя ноды-призрака: по нему её отличают от настоящих объектов. */
export const ALT_COPY_GHOST = 'alt-copy-ghost'

/**
 * Сверх этого числа призраки не рисуем. Копия всё равно состоится — пропадает
 * только вид «исходник на месте» во время жеста; клонировать сотни нод ради
 * него на каждое нажатие Alt незачем.
 */
export const ALT_COPY_GHOST_LIMIT = 200

/** Короче этого сдвига копию не делаем: она легла бы ровно на исходник. */
const NO_MOVE = 0.5

type CopyStore = Pick<CanvasStore, 'getItem' | 'getCollaboration' | 'duplicateWithOffset'>

interface Engaged {
  session: GroupDragSession
  ghosts: Konva.Node[]
  restoreCursor: (() => void) | null
}

let engaged: Engaged | null = null
/** Alt участвовал в жесте — его отпускание наше (см. altKeyBelongsToCanvas). */
let owedAltRelease = false

/** Что из ведомого жестом копируется: объекты доски. Карточки генерации — нет. */
export function altCopyIds(store: Pick<CanvasStore, 'getItem'>, session: GroupDragSession): string[] {
  return session.origins.map((origin) => origin.id).filter((id) => Boolean(store.getItem(id)))
}

/**
 * Хотят ли копию при таком положении клавиши.
 *
 * Копия возможна, когда тянут сам объект. Схватили карточку генерации — Alt
 * ничего не меняет: копировать у неё нечего, и перенос остаётся переносом.
 */
export function wantsAltCopy(
  store: Pick<CanvasStore, 'getItem'>,
  session: GroupDragSession,
  altHeld: boolean,
): boolean {
  if (altHeld) owedAltRelease = true
  return altHeld && Boolean(store.getItem(session.leader.id()))
}

/** Идёт ли сейчас перенос с копией в этом жесте. */
export function isAltCopying(session: GroupDragSession | null): boolean {
  return session != null && engaged?.session === session
}

function layerOf(session: GroupDragSession): Konva.Layer | null {
  return (session.leader as Partial<Konva.Node>).getLayer?.() ?? null
}

function showGhosts(store: Pick<CanvasStore, 'getItem'>, session: GroupDragSession): Konva.Node[] {
  const ghosts: Konva.Node[] = []
  for (const origin of session.origins) {
    if (ghosts.length >= ALT_COPY_GHOST_LIMIT) break
    // Карточка генерации стоит на месте сама (holdUncopied) — призрак ей не нужен.
    if (!store.getItem(origin.id)) continue
    const node = origin.node as Konva.Node | null
    const parent = node?.getParent?.()
    if (!node || !parent || typeof node.clone !== 'function') continue
    // ⚠️ Без id: по нему ищут настоящие ноды (трансформер, сессия жеста), и
    // двойник под тем же номером подменил бы объект.
    const ghost = node.clone({
      id: undefined, name: ALT_COPY_GHOST, x: origin.x, y: origin.y, listening: false, draggable: false,
    }) as Konva.Node
    parent.add(ghost as Konva.Group)
    // Ровно под самим объектом: исходник лежит под копией, которую ведут.
    ghost.zIndex(node.zIndex())
    ghosts.push(ghost)
  }
  return ghosts
}

function copyCursor(session: GroupDragSession): (() => void) | null {
  const container = (session.leader as Partial<Konva.Node>).getStage?.()?.container?.()
  if (!container) return null
  const previous = container.style.cursor
  container.style.cursor = 'copy'
  return () => {
    if (container.style.cursor === 'copy') container.style.cursor = previous
  }
}

/**
 * Привести вид в соответствие с клавишей. Зовётся на каждом кадре жеста и на
 * каждое нажатие и отпускание Alt; пока состояние то же — ничего не стоит.
 * Возвращает, идёт ли сейчас перенос с копией.
 */
export function syncAltCopy(store: CopyStore, session: GroupDragSession, altHeld: boolean): boolean {
  if (!wantsAltCopy(store, session, altHeld)) {
    if (engaged?.session === session) releaseAltCopy()
    return false
  }
  if (engaged?.session === session) return true
  releaseAltCopy()
  engaged = { session, ghosts: showGhosts(store, session), restoreCursor: copyCursor(session) }
  // Коллегам исходники никуда не «уезжают»: копия придёт к ним сразу готовой.
  store.getCollaboration()?.setPreview(null)
  layerOf(session)?.batchDraw()
  return true
}

/** Жест окончен при любом исходе: призраки убраны, курсор возвращён. */
export function releaseAltCopy(): void {
  const current = engaged
  if (!current) return
  engaged = null
  for (const ghost of current.ghosts) ghost.destroy()
  current.restoreCursor?.()
  layerOf(current.session)?.batchDraw()
}

/**
 * Карточки генерации с Alt остаются на месте: копии у них не бывает, и уехав
 * вместе с группой, они обещали бы то, чего не случится.
 */
export function holdUncopied(store: Pick<CanvasStore, 'getItem'>, session: GroupDragSession): void {
  for (const origin of session.origins) {
    if (!origin.node || origin.node === session.leader) continue
    if (store.getItem(origin.id)) continue
    origin.node.position({ x: origin.x, y: origin.y })
  }
}

/**
 * Отпустили с Alt: исходники возвращаются на свои места, копии встают туда,
 * куда их привели. Возвращает id копий; пусто — копировать было нечего.
 *
 * ⚠️ Сдвиг снимаем ДО возврата нод: он считается от ноды, за которую тянут.
 * ⚠️ Привели обратно на исходник (прилипание возвращает ровно на него) —
 * копии нет: она легла бы точно поверх, невидимой, и человек получил бы
 * двойника, о котором не знает.
 */
export function commitAltCopy(store: CopyStore, session: GroupDragSession): string[] {
  const dx = session.leader.x() - session.leaderX
  const dy = session.leader.y() - session.leaderY
  cancelGroupDrag(session)
  layerOf(session)?.batchDraw()
  if (Math.abs(dx) < NO_MOVE && Math.abs(dy) < NO_MOVE) return []
  return store.duplicateWithOffset(altCopyIds(store, session), dx, dy)
}

/**
 * Клавиша Alt: наша она или браузера. Возвращает, гасить ли действие по
 * умолчанию. `dragging` — идёт ли сейчас перенос.
 *
 * ⚠️ Chrome на Windows по отпусканию «одинокого» Alt уводит фокус в своё меню
 * (кнопка «⋮»), и нажатия мыши между нажатием и отпусканием этому не мешают.
 * После копирования клавиатура уходила бы с холста: первый же Delete или
 * Ctrl+Z не срабатывал бы. Поэтому отпускание гасим, если Alt участвовал в
 * жесте, — в том числе когда его отпустили уже ПОСЛЕ мыши (так и бывает
 * обычно). В остальное время клавишу не трогаем: у неё есть своя работа.
 */
export function altKeyBelongsToCanvas(type: 'keydown' | 'keyup', dragging: boolean): boolean {
  if (type === 'keydown') {
    if (dragging) owedAltRelease = true
    return dragging
  }
  const owed = owedAltRelease || dragging
  owedAltRelease = false
  return owed
}

/** Для тестов: забыть состояние прошлого жеста. */
export function resetAltCopy(): void {
  releaseAltCopy()
  owedAltRelease = false
}
