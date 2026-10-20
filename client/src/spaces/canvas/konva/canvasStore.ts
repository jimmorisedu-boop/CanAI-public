import type { JobResult } from '../../../types'
import {
  computeAdaptiveTextDimensions,
  DEFAULT_FONT_SIZE,
  DISPLAY_WIDTH,
  estimateTextHeight,
  GAP,
  rectIntersects,
  uid,
} from './canvasLayout'
import { AUDIO_ITEM_HEIGHT, AUDIO_ITEM_WIDTH } from './audioMeta'
import { History, type CanvasSnapshot } from './history'
import { api } from '../../../api'
import { DELIVERY_IMAGE_DIMENSIONS_FAILED, probeAudioDuration, probeGeneratedImageSize, probeImageSize, probeVideoSize } from './mediaProbe'
import { sanitizeArchive, toArchived, toCanvasItem } from './archive'
import type {
  ArchivedItem,
  CanvasCamera,
  CanvasDoc,
  CanvasItem,
  ItemKind,
  Placeholder,
  PinnedAsset,
  SketchStroke,
} from './types'
import { readingOrder } from './readingOrder'
import { EMPTY_DOC } from './types'
import { notify, showToast } from '../toastBus'
import { cancelGeneration, getGenerationTasks, type GenerationRetryDescriptor } from '../generationRegistry'
import { pendingRemoval } from './pendingRemoval'
import { forgetCardRetry } from './transientCardRetry'
import { requestMediaImportCancel } from '../mediaImportCancelBus'
import type { GenerationLaunchBase } from '../generationLaunches'
import { itemAabb } from './geometry'
import {
  alignSelection as computeAlignment,
  arrangeSelection as computeArrangement,
  type SelectionAlignment,
} from './selectionGeometry'
import { reportOnboardingSuccess } from '../onboardingEvents'
import {
  assessSeries,
  fitSeriesCamera,
  type Rect,
} from './generationSeriesGeometry'
import type { GenerationSeriesEntry } from './generationSeriesRevealModel'
import { quantizeScale } from './cameraScale'
import type { MediaImportResult, MediaImportTask, MediaLinkPreview, MediaProvider } from '../mediaImportTypes'
import { layoutLinkImport } from './linkImportLayout'
import {
  applyBoardPatch,
  applyPatch,
  orderMovedIds,
  patchWithInverse,
  type CanvasMutation,
  type CanvasMutationEnvelope,
  type CanvasMutationPort,
} from './canvasMutations'
type BoardCollaborationPort = {
  subscribe(listener: () => void): () => void
  getSnapshot(): { locks: Array<{ objectId: string }> }
  requestSelection(ids: readonly string[]): Promise<boolean>
  canMutate(ids: readonly string[]): boolean
  looksMutable?(ids: readonly string[]): boolean
  withSelection(ids: readonly string[], work: () => void | Promise<void>): Promise<boolean>
  setPreview(items: readonly unknown[] | null): void
  setCursor(point: { x: number; y: number } | null): void
  setVisible?(visible: boolean): void
  heldObjectIds?(): ReadonlySet<string>
}

export interface GenerationResultLookup {
  canvasIds: string[]
  archivedIds: string[]
  pendingJobIds: string[]
  missingJobIds: string[]
}

export interface ResolveJobOptions {
  /** Номер той же работы у сервера команды — чтобы узнать объект, поставленный им. */
  cloudJobId?: string
  /**
   * Промпт и модель объекта, которому НЕ нашлось карточки: у карточки они
   * свои, а без неё — что скажет вызывающий. ⚠️ Прежде здесь всегда стояло
   * «Макрос: <имя>», и результат обычной генерации по двойному клику клал в
   * строку промпта слово «Макрос» (жалоба 30.09.2026). Макрос теперь говорит
   * это о себе сам.
   */
  prompt?: string
  modelId?: string
}

interface CanvasMutationState {
  items: CanvasItem[]
  archive: ArchivedItem[]
  assets: PinnedAsset[]
  pending: Placeholder[]
  handledGenerationLaunchIds: string[]
}

interface ArrangePreviewState {
  ids: string[]
  /** Geometry captured before the first preview change. */
  source: CanvasItem[]
  positions: Map<string, { x: number; y: number }>
  /** A peer changed this object's position while the session was open. */
  conflictedIds: Set<string>
}

function sameIdList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function persistableRetry(
  retry: GenerationRetryDescriptor | undefined,
): GenerationRetryDescriptor | undefined {
  if (!retry) return undefined
  const refsArePortable = retry.refs.every((ref) => (
    ref.kind === 'text' || Boolean(ref.src?.startsWith('/media/'))
  ))
  return refsArePortable ? retry : undefined
}

function normalizeHandledGenerationLaunchIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (let index = value.length - 1; index >= 0 && ids.length < 100; index--) {
    const id = value[index]
    if (typeof id !== 'string' || id.length === 0 || id.length > 100 || seen.has(id)) continue
    seen.add(id)
    ids.unshift(id)
  }
  return ids
}

/**
 * Копия объекта на новом месте. Что копия уносит с собой, решается здесь —
 * одно правило на вставку, дублирование и перенос с Alt. Сеанс правки во
 * внешнем редакторе остаётся у исходника: копию в Фотошопе никто не открывал.
 */
function pastedCopy(item: CanvasItem, x: number, y: number): CanvasItem {
  const copy = { ...item, id: uid(), x, y }
  delete copy.externalEditSessionId
  return copy
}

/** Ход скачивания по ссылке, который живёт только на своём экране (пункт 3.8). */
const LOCAL_PROGRESS_KEYS = new Set(['downloadedBytes', 'totalBytes', 'percent'])

// Стор холста — императивный «редактор» вместо tldraw. Компоненты читают его
// через useSyncExternalStore (см. hooks.ts). Контент и камера — раздельные
// подписки: пан/зум не дёргает промпт-бар и т.п.
export class CanvasStore implements CanvasMutationPort {
  private items: CanvasItem[] = []
  private selected = new Set<string>()
  private camera: CanvasCamera = { x: 0, y: 0, scale: 1 }
  private savedCamera: CanvasCamera = { x: 0, y: 0, scale: 1 }
  private strokes: SketchStroke[] = []
  private strokeRedo: SketchStroke[] = []
  private assets: PinnedAsset[] = []
  private archive: ArchivedItem[] = []
  private pending: Placeholder[] = []
  private handledGenerationLaunchIds: string[] = []
  private history = new History()
  /** Ephemeral arrange coordinates. They are rendered, but never serialized or published. */
  private arrangePreview: ArrangePreviewState | null = null

  private container = { w: 1200, h: 800 }
  private generationSafeViewport: Rect = { x: 0, y: 0, w: 1200, h: 800 }
  private hasExplicitGenerationSafeViewport = false
  private lastRect: { x: number; y: number; w: number; h: number } | null = null

  private guides: number[][] = [] // направляющие выравнивания (мировые [x1,y1,x2,y2])
  private guidesRafId: number | null = null
  private generationFocus: string[] = []
  private onboardingFocus: string[] = []
  private onboardingFocusTimer: number | null = null

  private contentListeners = new Set<() => void>()
  private documentListeners = new Set<() => void>()
  private cameraListeners = new Set<() => void>()
  private decorationScaleListeners = new Set<() => void>()
  private manualCameraListeners = new Set<() => void>()
  private guidesListeners = new Set<() => void>()
  private generationFocusListeners = new Set<() => void>()
  private onboardingFocusListeners = new Set<() => void>()
  private mutationListeners = new Set<(event: CanvasMutationEnvelope) => void>()
  /** Куда складываются правки внутри collectMutations (null — отправлять сразу). */
  private mutationCollector: Array<{ mutation: CanvasMutation; inverse: CanvasMutation | null }> | null = null
  private collaboration: BoardCollaborationPort | null = null
  private collaborationUnsubscribe: (() => void) | null = null
  private collaborationListeners = new Set<() => void>()
  contentVersion = 0
  cameraVersion = 0
  private decorationScale = quantizeScale(this.camera.scale)
  manualCameraVersion = 0
  guidesVersion = 0
  generationFocusVersion = 0
  onboardingFocusVersion = 0
  collaborationVersion = 0

  // ── подписки ────────────────────────────────────────────
  subscribeContent = (l: () => void): (() => void) => {
    this.contentListeners.add(l)
    return () => this.contentListeners.delete(l)
  }
  subscribeDocument = (l: () => void): (() => void) => {
    this.documentListeners.add(l)
    return () => this.documentListeners.delete(l)
  }
  subscribeCamera = (l: () => void): (() => void) => {
    this.cameraListeners.add(l)
    return () => this.cameraListeners.delete(l)
  }
  subscribeDecorationScale = (l: () => void): (() => void) => {
    this.decorationScaleListeners.add(l)
    return () => this.decorationScaleListeners.delete(l)
  }
  subscribeManualCamera = (l: () => void): (() => void) => {
    this.manualCameraListeners.add(l)
    return () => this.manualCameraListeners.delete(l)
  }
  subscribeGuides = (l: () => void): (() => void) => {
    this.guidesListeners.add(l)
    return () => this.guidesListeners.delete(l)
  }
  subscribeGenerationFocus = (l: () => void): (() => void) => {
    this.generationFocusListeners.add(l)
    return () => this.generationFocusListeners.delete(l)
  }
  subscribeOnboardingFocus = (l: () => void): (() => void) => {
    this.onboardingFocusListeners.add(l)
    return () => this.onboardingFocusListeners.delete(l)
  }
  subscribeMutations = (listener: (event: CanvasMutationEnvelope) => void): (() => void) => {
    this.mutationListeners.add(listener)
    return () => this.mutationListeners.delete(listener)
  }
  subscribeCollaboration = (listener: () => void): (() => void) => {
    this.collaborationListeners.add(listener)
    return () => this.collaborationListeners.delete(listener)
  }
  getContentVersion = (): number => this.contentVersion
  getCameraVersion = (): number => this.cameraVersion
  getDecorationScale = (): number => this.decorationScale
  getManualCameraVersion = (): number => this.manualCameraVersion
  getGuidesVersion = (): number => this.guidesVersion
  getGenerationFocusVersion = (): number => this.generationFocusVersion
  getOnboardingFocusVersion = (): number => this.onboardingFocusVersion
  getCollaborationVersion = (): number => this.collaborationVersion

  setCollaboration(port: BoardCollaborationPort | null): void {
    this.collaborationUnsubscribe?.()
    this.collaborationUnsubscribe = null
    this.collaboration = port
    if (port) {
      this.collaborationUnsubscribe = port.subscribe(() => {
        this.collaborationVersion++
        this.collaborationListeners.forEach((listener) => listener())
      })
      // A selection may have been made while the board was still local/loading.
      // Reconcile it only after the controller is attached; the local selection
      // remains a view/reference focus until the server confirms ownership.
      if (this.selected.size > 0) void port.requestSelection([...this.selected])
    }
    this.collaborationVersion++
    this.collaborationListeners.forEach((listener) => listener())
  }

  getCollaboration = (): BoardCollaborationPort | null => this.collaboration

  canMutateItems(ids: readonly string[]): boolean {
    const unique = [...new Set(ids)].filter(Boolean)
    return unique.length === 0 || !this.collaboration || this.collaboration.canMutate(unique)
  }

  /** Показывать ли объект выделенным. Это вид, а не право — см. looksMutable. */
  looksEditable(ids: readonly string[]): boolean {
    const unique = [...new Set(ids)].filter(Boolean)
    if (unique.length === 0 || !this.collaboration) return true
    return this.collaboration.looksMutable?.(unique) ?? this.collaboration.canMutate(unique)
  }

  async withSelection(
    ids: readonly string[],
    work: () => void | Promise<void>,
  ): Promise<boolean> {
    if (!this.collaboration) {
      await work()
      return true
    }
    return this.collaboration.withSelection(ids, work)
  }

  private notifyContent(documentChanged = true): void {
    this.contentVersion++
    this.contentListeners.forEach((l) => l())
    if (documentChanged) this.documentListeners.forEach((l) => l())
  }
  private notifyCamera(): void {
    this.cameraVersion++
    this.cameraListeners.forEach((l) => l())
    const decorationScale = quantizeScale(this.camera.scale)
    if (decorationScale !== this.decorationScale) {
      this.decorationScale = decorationScale
      this.decorationScaleListeners.forEach((l) => l())
    }
  }
  noteManualCameraInteraction(): void {
    this.manualCameraVersion++
    this.manualCameraListeners.forEach((l) => l())
  }
  private notifyGuides(): void {
    this.guidesVersion++
    this.guidesListeners.forEach((l) => l())
  }
  private notifyGenerationFocus(): void {
    this.generationFocusVersion++
    this.generationFocusListeners.forEach((l) => l())
  }
  private notifyOnboardingFocus(): void {
    this.onboardingFocusVersion++
    this.onboardingFocusListeners.forEach((l) => l())
  }

  private commitMutation(mutation: CanvasMutation, inverse: CanvasMutation | null, recordUndo = true): void {
    if (this.mutationCollector && recordUndo) {
      this.mutationCollector.push({ mutation, inverse })
      return
    }
    const event: CanvasMutationEnvelope = {
      origin: 'local', mutation, inverse,
      ...(recordUndo ? {} : { recordUndo: false }),
    }
    this.mutationListeners.forEach((listener) => listener(event))
  }

  /**
   * Всё, что правит `work`, уходит ОДНОЙ пачкой: одна правка на сервер команды
   * и один шаг отмены.
   *
   * ⚠️ Раньше групповое удаление, вставка, дублирование и метки отдавали по
   * правке на объект: на сетевой доске удаление 300 объектов было 301
   * сообщением и 300 шагами Ctrl+Z (находка С-3 аудита 24.09.2026) — хотя
   * групповой перенос давно уходил пачкой.
   */
  private collectMutations(work: () => void): void {
    const outer = this.mutationCollector
    const collected: Array<{ mutation: CanvasMutation; inverse: CanvasMutation | null }> = []
    this.mutationCollector = collected
    try {
      work()
    } finally {
      this.mutationCollector = outer
    }
    if (outer) outer.push(...collected)
    else this.commitMutationBatch(collected)
  }

  private commitMutationBatch(batch: ReadonlyArray<{
    mutation: CanvasMutation
    inverse: CanvasMutation | null
  }>): void {
    if (this.mutationCollector) {
      this.mutationCollector.push(...batch)
      return
    }
    if (batch.length === 0) return
    if (batch.length === 1) {
      this.commitMutation(batch[0]!.mutation, batch[0]!.inverse)
      return
    }
    const first = batch[0]!
    const event: CanvasMutationEnvelope = {
      origin: 'local', mutation: first.mutation, inverse: first.inverse, batch,
    }
    this.mutationListeners.forEach((listener) => listener(event))
  }

  private mutationState(): CanvasMutationState {
    return {
      items: [...this.items],
      archive: [...this.archive],
      assets: [...this.assets],
      pending: this.pending.filter((pending) => !pending.transient),
      handledGenerationLaunchIds: [...this.handledGenerationLaunchIds],
    }
  }

  private changedPatch<T extends object>(before: T, after: T): Partial<T> {
    const patch: Partial<T> = {}
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>
    for (const key of keys) {
      if (!Object.is(before[key], after[key])) patch[key] = after[key]
    }
    return patch
  }

  /** Разница «до/после» одной правки стора — одной пачкой (см. collectMutations). */
  private commitMutationStateDiff(before: CanvasMutationState): void {
    this.collectMutations(() => this.emitMutationStateDiff(before))
  }

  private emitMutationStateDiff(before: CanvasMutationState): void {
    const beforeItems = new Map(before.items.map((item) => [item.id, item]))
    const afterItems = new Map(this.items.map((item) => [item.id, item]))
    const beforeArchive = new Map(before.archive.map((item) => [item.id, item]))
    const afterArchive = new Map(this.archive.map((item) => [item.id, item]))
    const contentIds = new Set([
      ...beforeItems.keys(), ...afterItems.keys(), ...beforeArchive.keys(), ...afterArchive.keys(),
    ])
    for (const id of contentIds) {
      const oldItem = beforeItems.get(id)
      const newItem = afterItems.get(id)
      const oldArchive = beforeArchive.get(id)
      const newArchive = afterArchive.get(id)
      if (oldItem && newArchive && !newItem) {
        this.commitMutation(
          { type: 'archive.add', objectId: id, payload: newArchive },
          { type: 'archive.restore', objectId: id, payload: oldItem },
        )
      } else if (oldArchive && newItem && !newArchive) {
        this.commitMutation(
          { type: 'archive.restore', objectId: id, payload: newItem },
          { type: 'archive.add', objectId: id, payload: oldArchive },
        )
      } else if (oldItem && !newItem && !newArchive) {
        this.commitMutation(
          { type: 'item.delete', objectId: id, payload: {} },
          { type: 'item.add', objectId: id, payload: oldItem },
        )
      } else if (!oldItem && !oldArchive && newItem) {
        this.commitMutation(
          { type: 'item.add', objectId: id, payload: newItem },
          { type: 'item.delete', objectId: id, payload: {} },
        )
      } else if (!oldItem && !oldArchive && newArchive) {
        this.commitMutation(
          { type: 'archive.add', objectId: id, payload: newArchive },
          { type: 'archive.delete', objectId: id, payload: {} },
        )
      } else if (oldArchive && !newArchive && !newItem) {
        this.commitMutation(
          { type: 'archive.delete', objectId: id, payload: {} },
          { type: 'archive.add', objectId: id, payload: oldArchive },
        )
      } else if (oldItem && newItem && oldItem !== newItem) {
        const patches = patchWithInverse(oldItem, this.changedPatch(oldItem, newItem))
        this.commitMutation(
          { type: 'item.patch', objectId: id, payload: patches.forward },
          { type: 'item.patch', objectId: id, payload: patches.inverse },
        )
      }
    }

    const oldOrder = before.items.map((item) => item.id)
    const newOrder = this.items.map((item) => item.id)
    if (oldOrder.length === newOrder.length && oldOrder.some((id, index) => id !== newOrder[index])) {
      const forwardMoved = orderMovedIds(oldOrder, newOrder)
      const inverseMoved = orderMovedIds(newOrder, oldOrder)
      this.commitMutation(
        { type: 'item.order', objectId: 'board-order', payload: { ids: newOrder, movedIds: forwardMoved } },
        { type: 'item.order', objectId: 'board-order', payload: { ids: oldOrder, movedIds: inverseMoved } },
      )
    }

    const beforeAssets = new Map(before.assets.map((asset) => [asset.slot, asset]))
    const afterAssets = new Map(this.assets.map((asset) => [asset.slot, asset]))
    for (const slot of new Set([...beforeAssets.keys(), ...afterAssets.keys()])) {
      const oldAsset = beforeAssets.get(slot)
      const newAsset = afterAssets.get(slot)
      const objectId = `asset-slot-${slot}`
      if (newAsset && newAsset !== oldAsset) {
        this.commitMutation(
          { type: 'asset.pin', objectId, payload: newAsset },
          oldAsset
            ? { type: 'asset.pin', objectId, payload: oldAsset }
            : { type: 'asset.unpin', objectId, payload: { slot } },
        )
      } else if (oldAsset && !newAsset) {
        this.commitMutation(
          { type: 'asset.unpin', objectId, payload: { slot } },
          { type: 'asset.pin', objectId, payload: oldAsset },
        )
      }
    }

    const beforePending = new Map(before.pending.map((item) => [item.id, item]))
    const afterPending = new Map(this.pending.filter((item) => !item.transient).map((item) => [item.id, item]))
    for (const id of new Set([...beforePending.keys(), ...afterPending.keys()])) {
      const oldPending = beforePending.get(id)
      const newPending = afterPending.get(id)
      if (!oldPending && newPending) {
        this.commitMutation(
          { type: 'pending.add', objectId: id, payload: newPending },
          { type: 'pending.delete', objectId: id, payload: {} },
        )
      } else if (oldPending && !newPending) {
        this.commitMutation(
          { type: 'pending.delete', objectId: id, payload: {} },
          { type: 'pending.add', objectId: id, payload: oldPending },
        )
      } else if (oldPending && newPending && oldPending !== newPending) {
        const patches = patchWithInverse(oldPending, this.changedPatch(oldPending, newPending))
        this.commitMutation(
          { type: 'pending.patch', objectId: id, payload: patches.forward },
          { type: 'pending.patch', objectId: id, payload: patches.inverse },
        )
      }
    }

    if (before.handledGenerationLaunchIds.join('\u0000') !== this.handledGenerationLaunchIds.join('\u0000')) {
      this.commitMutation(
        {
          type: 'board.patch', objectId: 'board',
          payload: { values: { handledGenerationLaunchIds: [...this.handledGenerationLaunchIds] }, unset: [] },
        },
        {
          type: 'board.patch', objectId: 'board',
          payload: { values: { handledGenerationLaunchIds: before.handledGenerationLaunchIds }, unset: [] },
        },
      )
    }
  }

  private applyRemoteMutation(mutation: CanvasMutation): void {
    this.noteArrangeRemoteConflict(mutation)
    if (mutation.type === 'item.add') {
      this.items = [
        ...this.items.filter((item) => item.id !== mutation.objectId),
        { ...mutation.payload, id: mutation.objectId },
      ]
    } else if (mutation.type === 'item.patch') {
      this.items = this.items.map((item) => item.id === mutation.objectId
        ? applyPatch(item, mutation.payload)
        : item)
    } else if (mutation.type === 'item.delete') {
      this.items = this.items.filter((item) => item.id !== mutation.objectId)
      this.selected.delete(mutation.objectId)
    } else if (mutation.type === 'item.order') {
      const order = new Map(mutation.payload.ids.map((id, index) => [id, index]))
      this.items = [...this.items].sort((left, right) => (
        (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      ))
    } else if (mutation.type === 'archive.add') {
      this.items = this.items.filter((item) => item.id !== mutation.objectId)
      this.archive = [
        ...this.archive.filter((item) => item.id !== mutation.objectId),
        { ...mutation.payload, id: mutation.objectId },
      ]
      this.selected.delete(mutation.objectId)
    } else if (mutation.type === 'archive.restore') {
      this.archive = this.archive.filter((item) => item.id !== mutation.objectId)
      this.items = [
        ...this.items.filter((item) => item.id !== mutation.objectId),
        { ...mutation.payload, id: mutation.objectId },
      ]
    } else if (mutation.type === 'archive.delete') {
      this.archive = this.archive.filter((item) => item.id !== mutation.objectId)
    } else if (mutation.type === 'asset.pin') {
      this.assets = [...this.assets.filter((asset) => asset.slot !== mutation.payload.slot), { ...mutation.payload }]
    } else if (mutation.type === 'asset.unpin') {
      this.assets = this.assets.filter((asset) => asset.slot !== mutation.payload.slot)
    } else if (mutation.type === 'pending.add') {
      this.pending = [
        ...this.pending.filter((item) => item.id !== mutation.objectId),
        { ...mutation.payload, id: mutation.objectId },
      ]
    } else if (mutation.type === 'pending.patch') {
      this.pending = this.pending.map((item) => item.id === mutation.objectId
        ? applyPatch(item, mutation.payload)
        : item)
    } else if (mutation.type === 'pending.delete') {
      this.pending = this.pending.filter((item) => item.id !== mutation.objectId)
      this.selected.delete(mutation.objectId)
    } else if (mutation.type === 'pending.complete') {
      // ⚠️ Экран повторяет ядро доски, а не спорит с ним. Сюда правка приходит
      // только от него (cloudProjectSync), и «карточка стала объектом» значит,
      // что сервер это уже сделал. Раньше здесь сверялся номер задачи на
      // карточке: стоило ему разойтись с ядром — завершение пропускалось, у
      // сервера стоял готовый объект, а у человека карточка крутилась вечно и
      // не убиралась ничем (жалоба 01.10.2026). Удалённую человеком карточку
      // это не воскрешает: ядро такое завершение сюда не присылает вовсе.
      const pendingId = mutation.payload.pendingId
      const card = this.pending.find((pending) => pending.id === pendingId && !pending.transient)
      if (card) {
        this.completePendingResult(pendingId, card.jobId, mutation.payload.item, {
          notify: false, publish: false, fresh: false,
        })
      } else {
        this.items = [
          ...this.items.filter((item) => item.id !== pendingId),
          { ...mutation.payload.item, id: pendingId },
        ]
        this.archive = this.archive.filter((item) => item.id !== pendingId)
      }
    } else if (mutation.type === 'board.patch') {
      // Множество, а не значение: списки объединяются так же, как на сервере.
      this.handledGenerationLaunchIds = applyBoardPatch(this.handledGenerationLaunchIds, mutation.payload)
    }
  }

  applyRemote(mutation: CanvasMutation): void {
    this.applyRemoteMutation(mutation)
    this.notifyContent()
  }

  applyRemoteBatch(mutations: readonly CanvasMutation[]): void {
    if (mutations.length === 0) return
    for (const mutation of mutations) this.applyRemoteMutation(mutation)
    this.notifyContent()
  }

  // ── чтение ──────────────────────────────────────────────
  getItems = (): CanvasItem[] => this.items
  /**
   * Items with an active arrange preview applied to their render coordinates.
   * The underlying `items` array remains durable until the panel is closed.
   */
  getRenderableItems = (): CanvasItem[] => {
    const preview = this.arrangePreview
    if (!preview) return this.items
    let changed = false
    const renderable = this.items.map((item) => {
      const position = preview.positions.get(item.id)
      if (!position || preview.conflictedIds.has(item.id)) return item
      if (item.x === position.x && item.y === position.y) return item
      changed = true
      return { ...item, ...position }
    })
    return changed ? renderable : this.items
  }
  getSelectableItems = (): Array<CanvasItem | Placeholder> => [...this.items, ...this.pending]
  getItem = (id: string): CanvasItem | undefined => this.items.find((i) => i.id === id)
  getSelectedIds = (): Set<string> => this.selected
  getSelection = (): string[] => [...this.selected]
  getSelectedItems = (): CanvasItem[] => Array.from(this.selected).map((id) => this.getItem(id)).filter((i): i is CanvasItem => !!i)
  getRenderableSelectedItems = (): CanvasItem[] => {
    const byId = new Map(this.getRenderableItems().map((item) => [item.id, item]))
    return Array.from(this.selected).map((id) => byId.get(id)).filter((i): i is CanvasItem => !!i)
  }
  getCamera = (): CanvasCamera => this.camera
  getGenerationFocus = (): string[] => this.generationFocus
  getOnboardingFocus = (): string[] => this.onboardingFocus
  getStrokes = (): SketchStroke[] => this.strokes
  getHandledGenerationLaunchIds = (): string[] => [...this.handledGenerationLaunchIds]
  getGenerationSeriesEntries(launchId: string): GenerationSeriesEntry[] {
    const itemEntries: GenerationSeriesEntry[] = this.items
      .filter((item) => item.sourceLaunch?.launchId === launchId)
      .map((item) => ({
        id: item.id,
        jobId: item.sourceJobId,
        phase: 'item',
        bounds: itemAabb(item),
      }))
    const pendingEntries: GenerationSeriesEntry[] = this.pending
      .filter((item) => item.launch?.launchId === launchId)
      .map((item) => ({
        id: item.id,
        jobId: item.jobId,
        phase: 'pending',
        pendingStatus: item.status,
        bounds: { x: item.x, y: item.y, w: item.w, h: item.h },
      }))
    return [...itemEntries, ...pendingEntries]
  }
  getGenerationSeriesTargetCamera(launchId: string): CanvasCamera | null {
    const entries = this.getGenerationSeriesEntries(launchId)
    if (entries.length === 0 || entries.some(({ bounds }) => (
      ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite)
      || bounds.w <= 0
      || bounds.h <= 0
    ))) return null

    const assessment = assessSeries(entries, this.camera, this.generationSafeViewport)
    if (!assessment) return null
    return fitSeriesCamera(this.camera, assessment.bounds, this.generationSafeViewport)
  }
  hasHandledGenerationLaunch(launchId: string): boolean {
    return this.handledGenerationLaunchIds.includes(launchId)
  }
  markGenerationLaunchHandled(launchId: string): boolean {
    if (!launchId || launchId.length > 100 || this.hasHandledGenerationLaunch(launchId)) return false
    const previous = [...this.handledGenerationLaunchIds]
    this.handledGenerationLaunchIds = [...this.handledGenerationLaunchIds, launchId].slice(-100)
    this.notifyContent()
    this.commitMutation(
      {
        type: 'board.patch', objectId: 'board',
        payload: { values: { handledGenerationLaunchIds: [...this.handledGenerationLaunchIds] }, unset: [] },
      },
      {
        type: 'board.patch', objectId: 'board',
        payload: { values: { handledGenerationLaunchIds: previous }, unset: [] },
      },
    )
    return true
  }
  // заглушки генерации (pending) не в items, но это уже не «пустой» канвас —
  // онбординг-подсказка должна уступить место крутящейся карточке результата
  isEmpty = (): boolean => this.items.length === 0 && this.pending.length === 0

  // направляющие выравнивания — временные, вне истории и сериализации.
  // onDragMove шлёт их на КАЖДЫЙ сырой pointermove (чаще, чем экран рисует
  // кадры) — уведомление подписчиков (а с ним пересчёт культинга по всем
  // объектам в KonvaCanvas) троттлим до одного раза за rAF, как камеру в
  // updateCameraThrottled; сама this.guides обновляется сразу (без задержки).
  getGuides = (): number[][] => this.guides
  setGuides(g: number[][]): void {
    if (g.length === 0 && this.guides.length === 0) return
    this.guides = g
    if (this.guidesRafId !== null) return
    this.guidesRafId = requestAnimationFrame(() => {
      this.guidesRafId = null
      this.notifyGuides()
    })
  }

  setContainerSize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return
    this.container = { w, h }
    if (!this.hasExplicitGenerationSafeViewport) {
      this.generationSafeViewport = { x: 0, y: 0, w, h }
    }
  }

  setGenerationSafeViewport(viewport: Rect): void {
    this.generationSafeViewport = { ...viewport }
    this.hasExplicitGenerationSafeViewport = true
  }

  resizeViewportPreservingCenter(w: number, h: number): void {
    if (w <= 0 || h <= 0) return
    const center = this.getViewportCenter()
    this.container = { w, h }
    if (!this.hasExplicitGenerationSafeViewport) {
      this.generationSafeViewport = { x: 0, y: 0, w, h }
    }
    this.centerOn(center.x, center.y)
  }

  // ── камера ──────────────────────────────────────────────
  setCamera(cam: CanvasCamera): void {
    this.camera = { ...cam }
    this.savedCamera = { ...cam }
    this.notifyCamera()
  }

  findGenerationResults(jobIds: string[]): GenerationResultLookup {
    const result: GenerationResultLookup = {
      canvasIds: [],
      archivedIds: [],
      pendingJobIds: [],
      missingJobIds: [],
    }
    const seen = new Set<string>()
    for (const jobId of jobIds) {
      if (seen.has(jobId)) continue
      seen.add(jobId)
      const item = this.items.find((candidate) => candidate.sourceJobId === jobId)
      if (item) {
        result.canvasIds.push(item.id)
        continue
      }
      const archived = this.archive.find((candidate) => candidate.sourceJobId === jobId)
      if (archived) {
        result.archivedIds.push(archived.id)
        continue
      }
      if (this.pending.some((candidate) => candidate.jobId === jobId)) {
        result.pendingJobIds.push(jobId)
        continue
      }
      result.missingJobIds.push(jobId)
    }
    return result
  }

  focusGenerationResults(jobIds: string[]): GenerationResultLookup {
    const result = this.findGenerationResults(jobIds)
    // Результата может ещё не быть — тогда показываем заглушку: человек нажал
    // «показать», чтобы увидеть, ГДЕ считается, и найти кнопку «Стоп».
    const focused = this.items.filter((item) => result.canvasIds.includes(item.id))
    const focusedCards = focused.length === 0 && result.pendingJobIds.length > 0
      ? this.pending.filter((card) => card.jobId != null && result.pendingJobIds.includes(card.jobId))
      : []
    if (focused.length > 0 || focusedCards.length > 0) {
      const boxes = [
        ...focused.map(itemAabb),
        ...focusedCards.map((card) => ({ x: card.x, y: card.y, w: card.w, h: card.h })),
      ]
      const minX = Math.min(...boxes.map((box) => box.x))
      const minY = Math.min(...boxes.map((box) => box.y))
      const maxX = Math.max(...boxes.map((box) => box.x + box.w))
      const maxY = Math.max(...boxes.map((box) => box.y + box.h))
      const target = fitSeriesCamera(
        this.camera,
        { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
        this.generationSafeViewport,
      )
      if (target) {
        // Явный переход из центра задач остаётся transient: он показывает
        // результат сейчас, но не переписывает сохранённую камеру проекта.
        this.camera = target
        this.notifyCamera()
      }
      const launchIds = new Set(focused.flatMap((item) => (
        item.sourceLaunch?.launchId ? [item.sourceLaunch.launchId] : []
      )))
      for (const launchId of launchIds) this.markGenerationLaunchHandled(launchId)
      this.generationFocus = [...result.canvasIds]
      this.notifyGenerationFocus()
    } else {
      this.clearGenerationFocus()
    }
    return result
  }

  clearGenerationFocus(): void {
    if (this.generationFocus.length === 0) return
    this.generationFocus = []
    this.notifyGenerationFocus()
  }

  getViewportCenter(): { x: number; y: number } {
    const { x, y, scale } = this.camera
    return {
      x: (this.container.w / 2 - x) / scale,
      y: (this.container.h / 2 - y) / scale,
    }
  }

  private centerOn(wx: number, wy: number): void {
    const s = this.camera.scale
    this.setCamera({ x: this.container.w / 2 - wx * s, y: this.container.h / 2 - wy * s, scale: s })
  }

  focusObject(id: string): void {
    const item = this.getItem(id) ?? this.pending.find((pending) => pending.id === id)
    if (!item) return
    this.centerOn(item.x + item.w / 2, item.y + item.h / 2)
  }

  revealItems(ids: string[]): void {
    const existing = ids.filter((id) => Boolean(this.getItem(id)))
    if (existing.length === 0) return
    this.setSelection(existing)
    const bounds = this.bbox(existing)
    if (bounds) this.centerOn(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2)
  }

  // Подсветка из обучения только показывает объект: не меняет выделение,
  // документ, историю или пользовательские действия.
  focusOnboardingItem(id: string, durationMs = 2200): void {
    if (!this.getItem(id)) return
    this.focusObject(id)
    if (this.onboardingFocusTimer !== null) window.clearTimeout(this.onboardingFocusTimer)
    this.onboardingFocus = [id]
    this.notifyOnboardingFocus()
    const timer = window.setTimeout(() => {
      if (this.onboardingFocusTimer === timer && this.onboardingFocus.length === 1 && this.onboardingFocus[0] === id) {
        this.onboardingFocus = []
        this.onboardingFocusTimer = null
        this.notifyOnboardingFocus()
      }
    }, durationMs)
    this.onboardingFocusTimer = timer
  }

  // общий bounding box набора объектов (по id) в мировых координатах
  private bbox(ids: string[]): { x: number; y: number; w: number; h: number } | null {
    const set = new Set(ids)
    const rects = this.items.filter((i) => set.has(i.id))
    if (rects.length === 0) return null
    const minX = Math.min(...rects.map((r) => r.x))
    const minY = Math.min(...rects.map((r) => r.y))
    const maxX = Math.max(...rects.map((r) => r.x + r.w))
    const maxY = Math.max(...rects.map((r) => r.y + r.h))
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  // если прямоугольник вне видимой области — мягко подвинем камеру к его центру
  private ensureVisible(r: { x: number; y: number; w: number; h: number }): void {
    const s = this.camera.scale
    const sx = r.x * s + this.camera.x
    const sy = r.y * s + this.camera.y
    const outside = sx < 0 || sy < 0 || sx + r.w * s > this.container.w || sy + r.h * s > this.container.h
    if (outside) this.centerOn(r.x + r.w / 2, r.y + r.h / 2)
  }

  // свежепоявившиеся объекты (результат генерации/редактора): CanvasItems один
  // раз проигрывает «приземление». Вне истории и сериализации.
  private freshIds = new Set<string>()
  /** Agent receipts are one-way: replaying a task must not resurrect a result
   * the user already undid or deleted from this open board. */
  private deliveredAgentResultIds = new Set<string>()
  /** Звук, для которого длительность и волну уже досчитывают (см. resolveJob). */
  private readonly audioDetailsRequested = new Set<string>()
  takeFresh = (id: string): boolean => this.freshIds.delete(id)

  // ── мутации (каждая жестовая операция = один шаг истории) ──
  // captureHistory=false — когда ряд объектов кладётся одним действием и
  // отменяться должен тоже целиком (см. placeVideoPieces): снимок берётся
  // один раз снаружи, иначе Ctrl+Z снимал бы нарезку по одному куску.
  addItem(
    item: Omit<CanvasItem, 'id'> & { id?: string },
    opts: { select?: boolean; fresh?: boolean; captureHistory?: boolean } = {},
  ): string {
    if (opts.captureHistory !== false) this.capture()
    const id = item.id ?? uid()
    const added = { ...item, id } as CanvasItem
    this.items = [...this.items, added]
    if (opts.select) {
      this.selected = new Set([id])
      if (this.collaboration) void this.collaboration.requestSelection([id])
    }
    if (opts.fresh) this.freshIds.add(id)
    this.lastRect = { x: item.x, y: item.y, w: item.w, h: item.h }
    this.notifyContent()
    this.commitMutation(
      { type: 'item.add', objectId: id, payload: added },
      { type: 'item.delete', objectId: id, payload: {} },
    )
    return id
  }

  /**
   * Apply a Host-staged local agent result without selecting it or moving the
   * camera. The normal project save is the durable receipt; Host promotes the
   * pending slot to canvasItems only after that save. Replayed pending snapshots
   * are harmless and one delivery is one undo/autosave batch.
   */
  placeAgentResults(
    taskId: string,
    results: ReadonlyArray<{ slotId: string; itemId: string; revision: number; artifactId: string }>,
    artifacts: ReadonlyArray<{
      artifactId: string
      revision: number
      kind: 'image' | 'video' | 'audio' | 'text' | 'document' | 'plan'
      caption: string
      mimeType: string
      mediaSrc: string
      text?: string
      width?: number
      height?: number
      durationMs?: number
    }>,
  ): string[] {
    const artifactByKey = new Map(artifacts.map((artifact) => [`${artifact.artifactId}:${artifact.revision}`, artifact]))
    const pending = results.filter((result) => !this.getItem(result.itemId) && !this.deliveredAgentResultIds.has(result.itemId))
      .map((result) => ({ result, artifact: artifactByKey.get(`${result.artifactId}:${result.revision}`) }))
      .filter((entry): entry is { result: (typeof results)[number]; artifact: (typeof artifacts)[number] } => Boolean(entry.artifact))
    if (pending.length === 0 || !this.canMutateItems(pending.map(({ result }) => result.itemId))) return []

    this.capture()
    const addedIds: string[] = []
    this.collectMutations(() => {
      for (const { result, artifact } of pending) {
        const textResult = artifact.kind === 'text' || artifact.kind === 'document' || artifact.kind === 'plan'
        let width = 520
        let height = 320
        let naturalWidth: number | undefined
        let naturalHeight: number | undefined
        let duration: number | undefined

        if (textResult) {
          width = 520
          height = Math.max(120, Math.min(600, (artifact.text?.split('\n').length ?? 4) * 24 + 50))
        } else if (artifact.kind === 'audio') {
          width = 320
          height = 96
          duration = artifact.durationMs ? artifact.durationMs / 1000 : undefined
        } else {
          width = 440
          const hasDims = typeof artifact.width === 'number' && typeof artifact.height === 'number' && artifact.width > 0 && artifact.height > 0
          height = hasDims ? Math.round((artifact.height! / artifact.width!) * 440) : 440
          naturalWidth = artifact.width ?? 440
          naturalHeight = artifact.height ?? 440
          duration = (artifact.kind === 'video' && artifact.durationMs) ? artifact.durationMs / 1000 : undefined
        }

        const position = this.nextPosition(width, height)
        const item = textResult
          ? {
              id: result.itemId,
              kind: 'text' as const,
              x: position.x,
              y: position.y,
              w: width,
              h: height,
              text: artifact.text ?? artifact.caption,
              name: artifact.caption,
              fontSize: 15,
              prompt: `Agent ${taskId}`,
            }
          : {
              id: result.itemId,
              kind: (artifact.kind === 'video' ? 'video' : artifact.kind === 'audio' ? 'audio' : 'image') as 'image' | 'video' | 'audio',
              x: position.x,
              y: position.y,
              w: width,
              h: height,
              src: artifact.mediaSrc,
              mime: artifact.mimeType,
              name: artifact.caption,
              naturalWidth: naturalWidth ?? width,
              naturalHeight: naturalHeight ?? height,
              ...(duration !== undefined ? { duration } : {}),
              prompt: `Agent ${taskId}`,
            }
        this.addItem(item, { captureHistory: false, fresh: true, select: false })
        this.deliveredAgentResultIds.add(result.itemId)
        addedIds.push(result.itemId)
      }
    })
    return addedIds
  }

  updateItem(id: string, patch: Partial<CanvasItem>, captureHistory = true): void {
    const current = this.getItem(id)
    if (!current) return
    if (!this.canMutateItems([id])) return
    if (captureHistory) {
      this.capture()
    }
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...patch } : i))
    this.notifyContent()
    const patches = patchWithInverse(current, patch)
    this.commitMutation(
      { type: 'item.patch', objectId: id, payload: patches.forward },
      { type: 'item.patch', objectId: id, payload: patches.inverse },
    )
  }

  /**
   * Поменять несколько объектов ОДНИМ шагом: одна правка и один Ctrl+Z.
   *
   * ⚠️ Изменение размера группы раньше звало `updateItem` на каждый объект:
   * трансформер завершает жест по объекту за раз, и каждое завершение
   * становилось своим шагом отмены — и на своей доске, и на сетевой.
   */
  updateItems(changes: ReadonlyArray<{ id: string; patch: Partial<CanvasItem> }>, captureHistory = true): void {
    const present = changes.filter(({ id }) => this.getItem(id))
    if (present.length === 0) return
    if (!this.canMutateItems(present.map(({ id }) => id))) return
    if (captureHistory) this.capture()
    const before = new Map(this.items.map((item) => [item.id, item]))
    const byId = new Map(present.map(({ id, patch }) => [id, patch]))
    this.items = this.items.map((item) => {
      const patch = byId.get(item.id)
      return patch ? { ...item, ...patch } : item
    })
    this.notifyContent()
    this.commitMutationBatch(present.map(({ id, patch }) => {
      const patches = patchWithInverse(before.get(id)!, patch)
      return {
        mutation: { type: 'item.patch', objectId: id, payload: patches.forward } as CanvasMutation,
        inverse: { type: 'item.patch', objectId: id, payload: patches.inverse } as CanvasMutation,
      }
    }))
  }

  updatePositions(positions: Array<{ id: string; x: number; y: number }>): void {
    if (!this.canMutateItems(positions.map(({ id }) => id))) return
    const byId = new Map(positions.map((position) => [position.id, position]))
    const movesItems = this.items.some((item) => byId.has(item.id))
    const movesPending = this.pending.some((item) => byId.has(item.id))
    if (!movesItems && !movesPending) return
    if (movesItems) this.capture()
    const previousItems = new Map(this.items.map((item) => [item.id, item]))
    const previousPending = new Map(this.pending.map((item) => [item.id, item]))
    this.items = this.items.map((item) => {
      const next = byId.get(item.id)
      return next ? { ...item, x: next.x, y: next.y } : item
    })
    this.pending = this.pending.map((item) => {
      const next = byId.get(item.id)
      return next ? { ...item, x: next.x, y: next.y } : item
    })
    this.notifyContent()
    const batch: Array<{ mutation: CanvasMutation; inverse: CanvasMutation | null }> = []
    for (const position of positions) {
      const item = previousItems.get(position.id)
      if (item) {
        const patches = patchWithInverse(item, { x: position.x, y: position.y })
        batch.push({
          mutation: { type: 'item.patch', objectId: item.id, payload: patches.forward },
          inverse: { type: 'item.patch', objectId: item.id, payload: patches.inverse },
        })
        continue
      }
      const pending = previousPending.get(position.id)
      if (pending) {
        const patches = patchWithInverse(pending, { x: position.x, y: position.y })
        batch.push({
          mutation: { type: 'pending.patch', objectId: pending.id, payload: patches.forward },
          inverse: { type: 'pending.patch', objectId: pending.id, payload: patches.inverse },
        })
      }
    }
    this.commitMutationBatch(batch)
  }

  removeItems(ids: string[]): void {
    const set = new Set(ids)
    if (![...set].some((id) => this.selected.has(id) || this.getItem(id) || this.pending.some((p) => p.id === id))) return
    if (!this.canMutateItems([...set])) return

    const runningJobs: string[] = []
    const runningImports: string[] = []
    // Карточку убираем всегда, кроме той, за которой стоит живая работа
    // (правила — в pendingRemoval: своя работа и карточка законченной задачи
    // убираются сразу, идущая генерация и скачивание — только через «Стоп»).
    const tasks = getGenerationTasks()
    const now = Date.now()
    const removedCards: Placeholder[] = []
    let stillRunning = false
    for (const p of this.pending.filter((candidate) => set.has(candidate.id))) {
      const verdict = pendingRemoval(p, now, (jobId) => tasks.find((task) => task.jobId === jobId)?.state)
      if (verdict === 'remove') {
        removedCards.push(p)
        continue
      }
      stillRunning = true
      if (verdict === 'running-import') runningImports.push(p.jobId!)
      else if (verdict === 'running-generation') runningJobs.push(p.jobId!)
    }
    if (removedCards.length > 0) {
      const gone = new Set(removedCards.map((card) => card.id))
      this.pending = this.pending.filter((card) => !gone.has(card.id))
      for (const id of gone) forgetCardRetry(id)
    }

    // Раньше здесь советовали «Подождите, пока догенерируется» — и это была
    // неправда: остановить можно, кнопка есть и на карточке, и в шапке.
    // Сообщение учило, что деньги не остановить.
    if (stillRunning) {
      notify({
        kind: 'info',
        message: runningImports.length > 0
          ? 'Download is still in progress'
          : runningJobs.length > 0 ? 'Generation is still in progress' : 'Generation is starting',
        ...(runningJobs.length > 0 || runningImports.length > 0
          ? {
              action: {
                label: 'Stop',
                run: () => {
                  for (const jobId of runningJobs) void cancelGeneration(jobId).catch(() => {})
                  for (const taskId of runningImports) requestMediaImportCancel(taskId)
                },
              },
            }
          : {}),
      })
    }

    this.collectMutations(() => {
      const hasRegularItems = [...set].some((id) => this.getItem(id))
      if (hasRegularItems) {
        const removed = this.items.filter((item) => set.has(item.id))
        const beforeImports = this.activeLinkImportIds(this.items)
        this.capture()
        this.items = this.items.filter((i) => !set.has(i.id))
        this.cancelRemovedLinkImports(beforeImports, this.activeLinkImportIds(this.items))
        for (const item of removed) {
          this.commitMutation(
            { type: 'item.delete', objectId: item.id, payload: {} },
            { type: 'item.add', objectId: item.id, payload: item },
          )
        }
      }

      // Карточка своей работы живёт только здесь — наружу о ней нечего сообщать.
      for (const item of removedCards.filter((candidate) => !candidate.transient)) {
        this.commitMutation(
          { type: 'pending.delete', objectId: item.id, payload: {} },
          { type: 'pending.add', objectId: item.id, payload: item },
        )
      }
    })

    this.selected = new Set(
      [...this.selected].filter(
        (id) => this.getItem(id) || this.pending.some((p) => p.id === id && p.status === 'loading')
      )
    )
    this.notifyContent()
  }

  removeSelected(): void {
    if (this.selected.size === 0) return
    this.removeItems([...this.selected])
  }

  // ── история ─────────────────────────────────────────────
  // Снапшот = холст + архив: отправка в архив переносит объект между ними,
  // и оба состояния обязаны откатываться одним Ctrl+Z (см. history.ts).
  private snapshot(): CanvasSnapshot {
    return { items: this.items, archive: this.archive }
  }

  private capture(): void {
    this.history.capture(this.snapshot())
  }

  private applySnapshot(state: CanvasSnapshot): void {
    this.arrangePreview = null
    const mutationBefore = this.mutationState()
    const beforeImports = this.activeLinkImportIds(this.items)
    this.items = state.items
    this.archive = state.archive
    this.selected = new Set([...this.selected].filter((id) => state.items.some((i) => i.id === id)))
    this.cancelRemovedLinkImports(beforeImports, this.activeLinkImportIds(this.items))
    this.notifyContent()
    this.commitMutationStateDiff(mutationBefore)
  }

  private activeLinkImportIds(items: CanvasItem[]): Set<string> {
    return new Set(items
      .filter((item) => item.kind === 'link' && item.link?.activeImportId)
      .map((item) => item.link!.activeImportId!))
  }

  private cancelRemovedLinkImports(before: Set<string>, after: Set<string>): void {
    for (const taskId of before) if (!after.has(taskId)) requestMediaImportCancel(taskId)
  }

  /**
   * A preview is intentionally local-only, so a peer's position update must
   * win over the still-open draft. Mark only the affected object as conflicted
   * and let the rest of the session continue to preview/finalize normally.
   */
  private noteArrangeRemoteConflict(mutation: CanvasMutation): void {
    const preview = this.arrangePreview
    if (!preview) return
    const id = mutation.objectId === 'board-order' || mutation.objectId === 'board'
      ? null
      : mutation.objectId
    if (!id || !preview.ids.includes(id)) return
    const positionChanged = mutation.type === 'item.add'
      || mutation.type === 'item.delete'
      || mutation.type === 'archive.add'
      || mutation.type === 'archive.restore'
      || (mutation.type === 'item.patch' && (
        Object.prototype.hasOwnProperty.call(mutation.payload.values, 'x')
        || Object.prototype.hasOwnProperty.call(mutation.payload.values, 'y')
        || mutation.payload.unset.includes('x')
        || mutation.payload.unset.includes('y')
      ))
    if (positionChanged) preview.conflictedIds.add(id)
  }

  // Есть ли что отменять. На компьютере это знание не нужно (Ctrl+Z сам
  // объяснит, что история пуста), а на планшете отмена — КНОПКА: погашенная
  // кнопка сразу говорит, что шагов назад больше нет, и не надо жать наугад.
  canUndo = (): boolean => this.history.canUndo
  canRedo = (): boolean => this.history.canRedo

  // Ctrl+Z раньше срабатывал молча: на большой доске отменённый шаг мог
  // оказаться за кадром, и было не понять, случилось ли вообще что-нибудь —
  // а на пустой истории тем более. Теперь шаг называется вслух.
  undo(): boolean {
    this.finalizeArrangePreview()
    // ⚠️ Спрашиваем looksEditable, а не canMutateItems: своя аренда истекает
    // молча, и по ней Ctrl+Z переставал работать вовсе (см. boardLeaseActions).
    // Аренду на нужные объекты тут всё равно не взять — отмена применяет
    // ЦЕЛЫЙ снимок, а не то, что выделено. Отказать вправе сервер: правку он
    // проверяет сам, а «занято» доска повторит с новой арендой.
    if (this.collaboration && !this.looksEditable([...this.selected])) return false
    const current = this.snapshot()
    const prev = this.history.undo(current)
    if (!prev) {
      notify({ kind: 'info', message: 'There\'s nothing left to undo', replaceKey: 'history' })
      return false
    }
    this.applySnapshot(prev)
    // Об удачной отмене не сообщаем: холст сам показал результат, а всплывашка
    // на каждое Ctrl+Z была одним из главных источников шума. Молчим только
    // когда получилось — «отменять больше нечего» по-прежнему объясняется.
    reportOnboardingSuccess('recovery')
    return true
  }

  redo(): void {
    this.finalizeArrangePreview()
    if (this.collaboration && !this.looksEditable([...this.selected])) return
    const current = this.snapshot()
    const next = this.history.redo(current)
    if (!next) {
      notify({ kind: 'info', message: 'Nothing else to restore', replaceKey: 'history' })
      return
    }
    this.applySnapshot(next)
  }

  // ── порядок слоёв (последний в массиве рисуется сверху) ──
  bringToFront(ids: string[]): void {
    const set = new Set(ids)
    if (!this.items.some((i) => set.has(i.id))) return
    if (!this.canMutateItems(ids)) return
    const previousOrder = this.items.map((item) => item.id)
    this.capture()
    const rest = this.items.filter((i) => !set.has(i.id))
    const top = this.items.filter((i) => set.has(i.id))
    this.items = [...rest, ...top]
    this.notifyContent()
    this.commitMutation(
      { type: 'item.order', objectId: 'board-order', payload: { ids: this.items.map((item) => item.id), movedIds: ids } },
      { type: 'item.order', objectId: 'board-order', payload: { ids: previousOrder, movedIds: ids } },
    )
  }

  sendToBack(ids: string[]): void {
    const set = new Set(ids)
    if (!this.items.some((i) => set.has(i.id))) return
    if (!this.canMutateItems(ids)) return
    const previousOrder = this.items.map((item) => item.id)
    this.capture()
    const rest = this.items.filter((i) => !set.has(i.id))
    const bottom = this.items.filter((i) => set.has(i.id))
    this.items = [...bottom, ...rest]
    this.notifyContent()
    this.commitMutation(
      { type: 'item.order', objectId: 'board-order', payload: { ids: this.items.map((item) => item.id), movedIds: ids } },
      { type: 'item.order', objectId: 'board-order', payload: { ids: previousOrder, movedIds: ids } },
    )
  }

  // ── метки группового экспорта ────────────────────────────
  // captureHistory=false для промежуточных цифр одного ввода (напр. «1» затем
  // «2» → «12»): иначе каждая цифра была бы отдельным шагом undo — тот же
  // приём, что и у живого ресайза текста (onTransform/onTransformEnd).
  setMarks(ids: string[], mark: number | undefined, captureHistory = true): void {
    const set = new Set(ids)
    if (!this.items.some((i) => set.has(i.id))) return
    if (!this.canMutateItems(ids)) return
    if (captureHistory) this.capture()
    const changed = this.items.filter((item) => set.has(item.id))
    this.items = this.items.map((i) => (set.has(i.id) ? { ...i, mark } : i))
    this.notifyContent()
    this.collectMutations(() => {
      for (const item of changed) {
        const patches = patchWithInverse(item, { mark })
        this.commitMutation(
          { type: 'item.patch', objectId: item.id, payload: patches.forward },
          { type: 'item.patch', objectId: item.id, payload: patches.inverse },
        )
      }
    })
  }

  // ── дублирование/вставка ────────────────────────────────
  // копии в указанное место (или центр вьюпорта) со смещением от оригинала; вставленное становится выделением
  pasteItems(
    source: CanvasItem[],
    targetWorld?: { x: number; y: number },
    viewportSize?: { w: number; h: number },
  ): string[] {
    return this.insertPasted(this.layoutPaste(source, targetWorld, viewportSize))
  }

  /**
   * Где встанут копии вставки — без самой вставки.
   *
   * ⚠️ Вставка с другой доски кладёт объекты не разом: файл каждого сперва
   * переезжает на доску назначения, а на его месте стоит карточка. Место
   * считается ОДИН раз для всей группы — иначе взаимное расположение
   * объектов зависело бы от того, чей файл доехал первым.
   */
  layoutPaste(
    source: CanvasItem[],
    targetWorld?: { x: number; y: number },
    viewportSize?: { w: number; h: number },
  ): CanvasItem[] {
    if (source.length === 0) return []
    const minX = Math.min(...source.map((i) => i.x))
    const minY = Math.min(...source.map((i) => i.y))
    const maxX = Math.max(...source.map((i) => i.x + i.w))
    const maxY = Math.max(...source.map((i) => i.y + i.h))
    const groupW = maxX - minX
    const groupH = maxY - minY

    let destX: number
    let destY: number

    if (targetWorld) {
      destX = targetWorld.x
      destY = targetWorld.y
    } else {
      const c = this.getCamera()
      const vw = viewportSize?.w ?? (typeof window !== 'undefined' ? window.innerWidth : 1200)
      const vh = viewportSize?.h ?? (typeof window !== 'undefined' ? window.innerHeight : 800)
      const viewCenterX = (vw / 2 - c.x) / c.scale
      const viewCenterY = (vh / 2 - c.y) / c.scale
      destX = viewCenterX - groupW / 2
      destY = viewCenterY - groupH / 2
    }

    const exactOverlap = this.items.some((i) => Math.abs(i.x - destX) < 1 && Math.abs(i.y - destY) < 1)
    if (exactOverlap) {
      destX += 28
      destY += 28
    }

    return source.map((i) => pastedCopy(i, i.x - minX + destX, i.y - minY + destY))
  }

  /** Положить уже расставленные копии — одной правкой и одним шагом отмены. */
  insertPasted(copies: CanvasItem[], options: { select?: boolean } = {}): string[] {
    if (copies.length === 0) return []
    this.capture()
    this.items = [...this.items, ...copies]
    if (options.select !== false) {
      this.selected = new Set(copies.map((c) => c.id))
      if (this.collaboration) void this.collaboration.requestSelection([...this.selected])
    }
    const last = copies[copies.length - 1]
    this.lastRect = { x: last.x, y: last.y, w: last.w, h: last.h }
    this.notifyContent()
    this.collectMutations(() => {
      for (const copy of copies) {
        this.commitMutation(
          { type: 'item.add', objectId: copy.id, payload: copy },
          { type: 'item.delete', objectId: copy.id, payload: {} },
        )
      }
    })
    return copies.map((c) => c.id)
  }

  reuseDownloadedLinkItems(
    linkId: string,
    requestedEntryIds?: string[],
  ): { copiedEntryIds: string[]; missingEntryIds: string[] } {
    const linkItem = this.getItem(linkId)
    if (linkItem?.kind !== 'link' || !linkItem.link) {
      return { copiedEntryIds: [], missingEntryIds: [] }
    }
    const requested = requestedEntryIds ? new Set(requestedEntryIds) : null
    const eligible = linkItem.link.entries.filter((entry) => !requested || requested.has(entry.id))
    const reusable = eligible.flatMap((entry) => {
      const mappedId = linkItem.link?.downloadedItemIds?.[entry.id]
      const item = mappedId ? this.getItem(mappedId) : undefined
      return item && (item.kind === 'image' || item.kind === 'video') && item.src
        ? [{ entry, item }]
        : []
    })
    const reusableIds = new Set(reusable.map(({ entry }) => entry.id))
    const missingEntryIds = eligible
      .filter((entry) => !reusableIds.has(entry.id))
      .map((entry) => entry.id)
    if (reusable.length === 0) return { copiedEntryIds: [], missingEntryIds }

    const minX = Math.min(...reusable.map(({ item }) => item.x))
    const minY = Math.min(...reusable.map(({ item }) => item.y))
    const copyIds = this.pasteItems(
      reusable.map(({ item }) => item),
      { x: minX + 28, y: minY + 28 },
    )
    const currentLink = this.getItem(linkId)?.link
    if (currentLink) {
      const downloadedItemIds = { ...currentLink.downloadedItemIds }
      reusable.forEach(({ entry }, index) => {
        downloadedItemIds[entry.id] = copyIds[index]
      })
      this.updateItem(linkId, { link: { ...currentLink, downloadedItemIds } }, false)
    }
    return {
      copiedEntryIds: reusable.map(({ entry }) => entry.id),
      missingEntryIds,
    }
  }

  duplicateSelected(): void {
    const sel = this.getSelectedItems()
    if (sel.length === 0) return
    const minX = Math.min(...sel.map((i) => i.x))
    const minY = Math.min(...sel.map((i) => i.y))
    this.pasteItems(sel, { x: minX + 28, y: minY + 28 })
  }

  /**
   * Копии объектов со сдвигом — перенос с зажатым Alt (см. altDragCopy).
   *
   * Исходники не трогаем вовсе. Копии встают ОДНОЙ правкой и одним шагом
   * отмены, в том же порядке слоёв, что исходники, и становятся выделением.
   * Карточки генерации сюда не попадают: копии у них не бывает.
   */
  duplicateWithOffset(ids: readonly string[], dx: number, dy: number): string[] {
    const wanted = new Set(ids)
    const source = this.items.filter((item) => wanted.has(item.id))
    return this.insertPasted(source.map((item) => pastedCopy(item, item.x + dx, item.y + dy)))
  }

  selectAll(): void {
    // Порядок — «как читают»: из него берутся номера референсов @1/@2, и
    // человек ждёт, что первым будет левый верхний, а не тот, что появился
    // на доске раньше всех (см. readingOrder).
    this.setSelection(readingOrder(this.getSelectableItems()).map((i) => i.id))
  }

  // ── выделение ───────────────────────────────────────────
  setSelection(ids: string[]): void {
    const current = [...this.selected]
    if (!sameIdList(current, ids) && this.arrangePreview) this.finalizeArrangePreview()
    const next = new Set(ids)
    if (next.size === this.selected.size && [...next].every((id) => this.selected.has(id))) {
      if (this.collaboration && !this.canMutateItems(ids)) void this.collaboration.requestSelection(ids)
      return
    }
    this.selected = next
    this.notifyContent(false)
    if (this.collaboration) void this.collaboration.requestSelection([...next])
  }

  /** Align all selected objects by one edge or centre in one undo step. */
  alignSelection(ids: string[], alignment: SelectionAlignment): void {
    this.finalizeArrangePreview()
    const arranged = this.orderedSelectionItems(ids)
    if (arranged.length < 2 || !this.canMutateItems(arranged.map((item) => item.id))) return
    this.applySelectionPositions(computeAlignment(arranged, alignment))
  }

  arrangeInRow(ids: string[], options: { gap: number }): void {
    this.arrangeSelection(ids, 'row', options)
  }

  arrangeInColumn(ids: string[], options: { gap: number }): void {
    this.arrangeSelection(ids, 'column', options)
  }

  arrangeInGrid(ids: string[], options: { columns: number; gap: number }): void {
    this.arrangeSelection(ids, 'grid', options)
  }

  private arrangeSelection(
    ids: string[],
    arrangement: 'row' | 'column' | 'grid',
    options: { columns?: number; gap: number },
  ): void {
    this.finalizeArrangePreview()
    const arranged = this.orderedSelectionItems(ids)
    // Все виды CanvasItem — прямоугольники. AABB из selectionGeometry также
    // учитывает rotation, поэтому сетка и ряд не «съедают» повёрнутые карточки.
    if (arranged.length < 2 || !this.canMutateItems(arranged.map((item) => item.id))) return
    this.applySelectionPositions(computeArrangement(arranged, arrangement, options))
  }

  private orderedSelectionItems(ids: readonly string[]): CanvasItem[] {
    const order = new Map(ids.map((id, index) => [id, index]))
    return this.items
      .filter((item) => order.has(item.id))
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  }

  /** Apply already-computed positions synchronously, then emit one batch. */
  private applySelectionPositions(
    positions: ReadonlyArray<{ id: string; x: number; y: number }>,
    inversePositions?: ReadonlyMap<string, { x: number; y: number }>,
  ): boolean {
    const present = positions.filter((position) => {
      const item = this.getItem(position.id)
      return !!item && (item.x !== position.x || item.y !== position.y)
    })
    if (present.length === 0 || !this.canMutateItems(present.map(({ id }) => id))) return false
    const before = new Map(this.items.map((item) => [item.id, item]))
    this.capture()
    const changes = present.map(({ id, x, y }) => ({ id, patch: { x, y } }))
    const changesById = new Map(changes.map((change) => [change.id, change.patch]))
    this.items = this.items.map((item) => {
      const patch = changesById.get(item.id)
      return patch ? { ...item, ...patch } : item
    })
    this.notifyContent()
    this.commitMutationBatch(changes.map(({ id, patch }) => {
      const current = before.get(id)!
      const patches = patchWithInverse(current, patch)
      const inverse = inversePositions?.get(id)
      const inversePatch = inverse
        ? { values: { x: inverse.x, y: inverse.y }, unset: [] }
        : patches.inverse
      return {
        mutation: { type: 'item.patch', objectId: id, payload: patches.forward } as CanvasMutation,
        inverse: { type: 'item.patch', objectId: id, payload: inversePatch } as CanvasMutation,
      }
    }))
    return true
  }

  private arrangeSource(ids: readonly string[]): CanvasItem[] {
    return ids
      .map((id) => this.getItem(id))
      .filter((item): item is CanvasItem => !!item)
  }

  private updateArrangePreview(
    ids: readonly string[],
    compute: (source: CanvasItem[]) => ReadonlyArray<{ id: string; x: number; y: number }>,
    useCurrentPreview = false,
  ): boolean {
    const orderedIds = [...ids]
    const source = this.arrangeSource(orderedIds)
    if (source.length < 2 || !this.canMutateItems(source.map((item) => item.id))) return false
    let preview = this.arrangePreview
    if (!preview || !sameIdList(preview.ids, orderedIds)) {
      if (preview) this.finalizeArrangePreview()
      preview = {
        ids: source.map((item) => item.id),
        source: source.map((item) => ({ ...item })),
        positions: new Map(),
        conflictedIds: new Set(),
      }
      this.arrangePreview = preview
    }
    const input = useCurrentPreview
      ? preview.source.map((source) => {
        const current = this.getItem(source.id)
        const position = preview.positions.get(source.id)
        if (!current || preview.conflictedIds.has(source.id) || !position) return current ?? source
        return { ...source, x: position.x, y: position.y }
      })
      : preview.source
    const positions = compute(input)
    preview.positions = new Map(positions.map(({ id, x, y }) => [id, { x, y }]))
    this.notifyContent(false)
    return true
  }

  previewAlignSelection(ids: string[], alignment: SelectionAlignment): boolean {
    return this.updateArrangePreview(ids, (source) => computeAlignment(source, alignment), true)
  }

  previewArrangeInRow(ids: string[], options: { gap: number }): boolean {
    return this.updateArrangePreview(ids, (source) => computeArrangement(source, 'row', options))
  }

  previewArrangeInColumn(ids: string[], options: { gap: number }): boolean {
    return this.updateArrangePreview(ids, (source) => computeArrangement(source, 'column', options))
  }

  previewArrangeInGrid(ids: string[], options: { columns: number; gap: number }): boolean {
    return this.updateArrangePreview(ids, (source) => computeArrangement(source, 'grid', options))
  }

  /** Persist the current draft as one history step and one mutation batch. */
  finalizeArrangePreview(): boolean {
    const preview = this.arrangePreview
    if (!preview) return false
    this.arrangePreview = null
    const positions = [...preview.positions.entries()]
      .filter(([id]) => !preview.conflictedIds.has(id))
      .map(([id, position]) => ({ id, ...position }))
    const inversePositions = new Map(preview.source.map((item) => [item.id, { x: item.x, y: item.y }]))
    if (positions.length === 0 || !this.canMutateItems(positions.map(({ id }) => id))) {
      this.notifyContent(false)
      return false
    }
    const applied = this.applySelectionPositions(positions, inversePositions)
    if (!applied) this.notifyContent(false)
    return applied
  }

  select(id: string, additive = false): void {
    if (additive) {
      const next = new Set(this.selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      this.setSelection([...next])
    } else {
      this.setSelection([id])
    }
  }

  clearSelection(): void {
    this.setSelection([])
  }

  // ── закреплённые ассеты (полка справа) — не в истории ────
  getAssets = (): PinnedAsset[] => this.assets
  getAsset = (slot: number): PinnedAsset | undefined => this.assets.find((a) => a.slot === slot)

  // ── заглушки будущих результатов (спиннеры на канвасе) ──
  getPending = (): Placeholder[] => this.pending

  placeLink(url: string, at?: { x: number; y: number }): string {
    const w = 360
    const h = 280
    const center = at ?? this.getViewportCenter()
    return this.addItem({
      kind: 'link',
      x: center.x - w / 2,
      y: center.y - h / 2,
      w,
      h,
      name: url,
      link: {
        url,
        normalizedUrl: url,
        provider: 'direct',
        sourceLabel: 'Link',
        title: url,
        state: 'loading-preview',
        entries: [],
      },
    }, { select: true })
  }

  applyLinkPreview(id: string, preview: MediaLinkPreview): void {
    const item = this.getItem(id)
    if (item?.kind !== 'link' || !item.link) return
    this.updateItem(id, {
      name: preview.title,
      link: {
        ...item.link,
        ...preview,
        state: 'ready',
        error: undefined,
        // Вход сработал — иначе флаг пережил бы удачное превью и карточка
        // продолжала бы предлагать войти.
        needsLogin: false,
        transientError: undefined,
        downloadedItemIds: item.link.downloadedItemIds ?? {},
      },
    }, false)
  }

  failLinkPreview(
    id: string,
    error: string,
    options: {
      needsLogin?: boolean
      // ⚠️ Площадку приносит САМ отказ: превью не доехало, и без этого карточка
      // осталась бы с заглушкой «Ссылка» — и на кнопке, и в запросе входа.
      source?: { provider: MediaProvider; sourceLabel: string }
      /** CanAI не ответил вовремя — о ссылке это не говорит ничего. */
      transient?: boolean
    } = {},
  ): void {
    const item = this.getItem(id)
    if (item?.kind !== 'link' || !item.link) return
    this.updateItem(id, {
      link: {
        ...item.link,
        ...(options.source ?? {}),
        state: 'error',
        error,
        needsLogin: options.needsLogin ?? false,
        transientError: options.transient || undefined,
      },
    }, false)
  }

  reserveMediaImport(linkId: string, task: MediaImportTask): string[] {
    const link = this.getItem(linkId)
    if (link?.kind !== 'link' || !link.link) return []
    const occupied = [
      ...this.items.filter((item) => item.id !== linkId),
      ...this.pending,
    ].map(({ x, y, w, h }) => ({ x, y, w, h }))
    const slots = layoutLinkImport(link, task.items, occupied)
    const now = Date.now()
    const created: Placeholder[] = slots.map((slot, index) => ({
      id: uid(),
      jobId: task.id,
      taskType: 'media-import',
      importEntryId: task.items[index].id,
      sourceLinkId: linkId,
      x: slot.x,
      y: slot.y,
      w: slot.w,
      h: slot.h,
      kind: slot.kind,
      label: task.items[index].title || 'Media',
      stage: 'Preparing…',
      status: 'loading',
      startedAt: now,
      downloadedBytes: 0,
    }))
    this.pending = [...this.pending, ...created]
    this.items = this.items.map((item) => item.id === linkId ? {
      ...item,
      link: { ...item.link!, activeImportId: task.id },
    } : item)
    if (created.length > 0) {
      const minX = Math.min(...created.map((item) => item.x))
      const minY = Math.min(...created.map((item) => item.y))
      const maxX = Math.max(...created.map((item) => item.x + item.w))
      const maxY = Math.max(...created.map((item) => item.y + item.h))
      this.ensureVisible({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
    }
    this.notifyContent()
    for (const pending of created) {
      if (pending.transient) continue
      this.commitMutation(
        { type: 'pending.add', objectId: pending.id, payload: pending },
        { type: 'pending.delete', objectId: pending.id, payload: {} },
      )
    }
    const changedLink = this.getItem(linkId)
    if (changedLink) {
      const patches = patchWithInverse(link, { link: changedLink.link })
      this.commitMutation(
        { type: 'item.patch', objectId: linkId, payload: patches.forward },
        { type: 'item.patch', objectId: linkId, payload: patches.inverse },
      )
    }
    return created.map((item) => item.id)
  }

  updateMediaImportProgress(task: MediaImportTask): void {
    const previous = new Map(this.pending.map((item) => [item.id, item]))
    const byId = new Map(task.items.map((item) => [item.id, item]))
    let changed = false
    this.pending = this.pending.map((placeholder) => {
      if (placeholder.taskType !== 'media-import' || placeholder.jobId !== task.id || !placeholder.importEntryId) return placeholder
      const item = byId.get(placeholder.importEntryId)
      if (!item) return placeholder
      const failed = item.status === 'error' || item.status === 'cancelled' || item.status === 'interrupted'
      const next: Placeholder = {
        ...placeholder,
        status: failed ? 'error' : 'loading',
        error: item.error ?? (item.status === 'cancelled' ? 'Download canceled' : item.status === 'interrupted' ? 'Download interrupted' : undefined),
        downloadedBytes: Math.max(placeholder.downloadedBytes ?? 0, item.downloadedBytes),
        totalBytes: item.totalBytes ?? placeholder.totalBytes,
        percent: item.percent ?? placeholder.percent,
        stage: item.stage ?? placeholder.stage,
      }
      const keys: Array<keyof Placeholder> = [
        'status', 'error', 'downloadedBytes', 'totalBytes', 'percent', 'stage',
      ]
      if (keys.every((key) => Object.is(next[key], placeholder[key]))) return placeholder
      changed = true
      return next
    })
    if (changed) {
      this.notifyContent()
      for (const pending of this.pending) {
        const before = previous.get(pending.id)
        if (!before || before === pending) continue
        // ⚠️ Счётчики байтов и процент — только на этом экране (пункт 3.8,
        // находка С-8): они менялись раз в 0,8 с на каждую карточку, и каждая
        // такая правка уезжала в общую доску и будила интерфейс у всех
        // коллег. На доску уходят только перемены, которые им нужны: статус,
        // ошибка и стадия.
        const patch = Object.fromEntries(Object.entries(pending).filter(
          ([key, value]) => !LOCAL_PROGRESS_KEYS.has(key) && before[key as keyof Placeholder] !== value,
        )) as Partial<Placeholder>
        if (Object.keys(patch).length === 0) continue
        const patches = patchWithInverse(before, patch)
        this.commitMutation(
          { type: 'pending.patch', objectId: pending.id, payload: patches.forward },
          { type: 'pending.patch', objectId: pending.id, payload: patches.inverse },
          false,
        )
      }
    }
  }

  async completeMediaImport(
    task: MediaImportTask,
    adoptResult?: (result: MediaImportResult) => Promise<MediaImportResult>,
  ): Promise<string[]> {
    const placeholders = new Map(this.pending
      .filter((item) => item.taskType === 'media-import' && item.jobId === task.id && item.importEntryId)
      .map((item) => [item.importEntryId!, item]))
    const attempts = await Promise.all(task.items.map(async (entry) => {
      const placeholder = placeholders.get(entry.id)
      if (!placeholder || entry.status !== 'completed' || !entry.result?.url) return null
      try {
        const isVideo = entry.result.mime.startsWith('video/')
        const size = entry.result.width && entry.result.height
          ? { width: entry.result.width, height: entry.result.height }
          : isVideo
            ? await probeVideoSize(entry.result.url)
            : await probeImageSize(entry.result.url)
        const result = adoptResult ? await adoptResult(entry.result) : entry.result
        return { entry, placeholder, result, isVideo, size }
      } catch (error) {
        return { entryId: entry.id, error: error instanceof Error ? error.message : 'Failed to transfer file' }
      }
    }))
    const currentLinkId = this.pending.find((item) => item.jobId === task.id && item.sourceLinkId)?.sourceLinkId
    if (currentLinkId && !this.getItem(currentLinkId)) {
      const before = this.mutationState()
      this.pending = this.pending.filter((item) => item.jobId !== task.id)
      this.notifyContent()
      this.commitMutationStateDiff(before)
      return []
    }
    // Передача большого видео может идти долго. За это время ссылку или
    // заглушку могли удалить; поздний ответ не должен воскресить файл.
    const activePlaceholderIds = new Set(this.pending.map((item) => item.id))
    const prepared = attempts.filter((value): value is Extract<NonNullable<typeof value>, { placeholder: Placeholder }> => (
      value !== null && 'placeholder' in value && activePlaceholderIds.has(value.placeholder?.id ?? '')
    ))
    const transferErrors = new Map(attempts.flatMap((value) => (
      value && 'entryId' in value ? [[value.entryId, value.error] as const] : []
    )))

    const linkId = this.pending.find((item) => item.jobId === task.id && item.sourceLinkId)?.sourceLinkId
    const link = linkId ? this.getItem(linkId) : undefined
    const mutationBefore = this.mutationState()
    // В undo-снимке ссылка уже не должна выглядеть как продолжающая скачивать:
    // серверная задача терминальна. При этом mapping результатов добавится ПОСЛЕ
    // capture, поэтому один Ctrl+Z уберёт всю группу и mappings, но не карточку.
    if (prepared.length > 0) {
      this.items = this.items.map((item) => item.id === linkId && item.link ? {
        ...item,
        link: { ...item.link, activeImportId: undefined },
      } : item)
      this.capture()
    }
    const successfulIds: string[] = []
    const mapping = { ...(link?.link?.downloadedItemIds ?? {}) }
    const successfulEntryIds = new Set(prepared.map(({ entry }) => entry.id))
    this.pending = this.pending
      .filter((placeholder) => !(placeholder.jobId === task.id && placeholder.importEntryId && successfulEntryIds.has(placeholder.importEntryId)))
      .map((placeholder) => {
        if (placeholder.jobId !== task.id || !placeholder.importEntryId) return placeholder
        const entry = task.items.find((item) => item.id === placeholder.importEntryId)
        if (!entry) return placeholder
        return {
          ...placeholder,
          status: 'error',
          stage: undefined,
          error: transferErrors.get(entry.id) ?? entry.error ?? (entry.status === 'cancelled' ? 'Download canceled' : 'Failed to download media'),
        }
      })
    for (const { entry, placeholder, result, isVideo, size } of prepared) {
      const id = uid()
      const h = Math.max(40, Math.round((placeholder.w * size.height) / size.width))
      this.items = [...this.items, {
        id,
        kind: isVideo ? 'video' : 'image',
        x: placeholder.x,
        y: placeholder.y + placeholder.h - h,
        w: placeholder.w,
        h,
        src: result.url,
        assetId: result.assetId,
        assetRevision: result.assetRevision,
        assetChecksum: result.assetChecksum,
        mime: result.mime,
        name: result.name,
        naturalWidth: size.width,
        naturalHeight: size.height,
      }]
      mapping[entry.id] = id
      successfulIds.push(id)
      this.freshIds.add(id)
    }
    if (linkId) {
      this.items = this.items.map((item) => item.id === linkId && item.link ? {
        ...item,
        link: { ...item.link, activeImportId: undefined, downloadedItemIds: mapping },
      } : item)
    }
    if (successfulIds.length > 0) this.selected = new Set(successfulIds)
    this.notifyContent()
    this.commitMutationStateDiff(mutationBefore)
    return successfulIds
  }

  cancelMediaImportPending(task: MediaImportTask): void {
    this.updateMediaImportProgress(task)
    const linkId = this.pending.find((item) => item.jobId === task.id)?.sourceLinkId
    if (!linkId) return
    const link = this.getItem(linkId)
    if (link?.link) this.updateItem(linkId, {
      link: { ...link.link, activeImportId: undefined },
    }, false)
  }

  // ряд заглушек: справа от референса по его НИЖНЕМУ краю (или по центру
  // видимой области, если референса нет), одинаковая ширина, равные промежутки
  addPendingRow(
    count: number,
    opts: {
      kind: 'image' | 'video' | 'audio'
      label: string
      anchorIds?: string[]
      aspect?: number
      prompt?: string
      modelId?: string
      referenceIds?: string[]
      usedReferences?: boolean
      launch?: GenerationLaunchBase
      retry?: GenerationRetryDescriptor
      transient?: boolean
      /** Ширина в мире доски; без неё — общая ширина результатов генерации. */
      width?: number
    },
  ): string[] {
    const w = opts.width && Number.isFinite(opts.width) && opts.width > 0 ? opts.width : DISPLAY_WIDTH
    // высота под ожидаемые пропорции результата (aspect = ширина/высота);
    // при готовности подстроится под реальный размер (см. resolveJob)
    const aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : 1
    const h = Math.max(40, Math.round(w / aspect))
    const totalW = count * w + (count - 1) * GAP
    const anchor = opts.anchorIds && opts.anchorIds.length ? this.bbox(opts.anchorIds) : null
    let startX: number
    let baseBottom: number
    if (anchor) {
      startX = anchor.x + anchor.w + GAP
      baseBottom = anchor.y + anchor.h
    } else {
      const c = this.getViewportCenter()
      startX = c.x - totalW / 2
      baseBottom = c.y + h / 2
    }

    // Сдвигаем по оси X, чтобы не накладываться на существующие элементы или другие заглушки
    let x = startX
    const y = baseBottom - h
    let overlap = true
    const maxAttempts = 100
    let attempts = 0
    while (overlap && attempts < maxAttempts) {
      attempts++
      overlap = false
      const currentRect = { x, y, w: totalW, h }
      
      const overlappingItem = this.items.find((item) => rectIntersects(currentRect, item))
      if (overlappingItem) {
        x = overlappingItem.x + overlappingItem.w + GAP
        overlap = true
        continue
      }
      
      const overlappingPending = this.pending.find((p) => rectIntersects(currentRect, p))
      if (overlappingPending) {
        x = overlappingPending.x + overlappingPending.w + GAP
        overlap = true
        continue
      }
    }
    startX = x

    const created: Placeholder[] = []
    for (let i = 0; i < count; i++) {
      created.push({
        id: uid(),
        x: startX + i * (w + GAP),
        y: baseBottom - h,
        w,
        h,
        kind: opts.kind,
        label: opts.label,
        status: 'loading',
        startedAt: Date.now(),
        prompt: opts.prompt,
        modelId: opts.modelId,
        referenceIds: opts.referenceIds,
        usedReferences: opts.usedReferences,
        launch: opts.launch ? { ...opts.launch, variantIndex: i + 1 } : undefined,
        retry: opts.retry,
        transient: opts.transient,
      })
    }
    this.pending = [...this.pending, ...created]
    this.ensureVisible({ x: startX, y: baseBottom - h, w: totalW, h })
    this.notifyContent()
    for (const pending of created) {
      if (pending.transient) continue
      this.commitMutation(
        { type: 'pending.add', objectId: pending.id, payload: pending },
        { type: 'pending.delete', objectId: pending.id, payload: {} },
      )
    }
    return created.map((p) => p.id)
  }

  /** Локальная карточка появляется на месте файла, пока тот едет на сервер команды. */
  addTransientUploadPending(
    rect: { x: number; y: number; w: number; h: number },
    kind: Placeholder['kind'],
    label: string,
    extra: Pick<Placeholder, 'previewSrc' | 'previewCrop' | 'rotation' | 'stage'> = {},
  ): string {
    const id = uid()
    this.pending = [...this.pending, {
      id, ...rect, kind, label, status: 'loading', startedAt: Date.now(), transient: true, ...extra,
    }]
    this.notifyContent()
    return id
  }

  /**
   * Встать объектом на место карточки своей работы. Нужен там, где объект
   * собирает сам вызывающий: у внешней правки своя пометка сеанса, которую
   * `resolveJob` не знает. Ширина и низ — у карточки, высота — по пропорциям
   * файла; один шаг истории, как у кадра из клипа.
   */
  completeLocalWork(cardId: string, item: Omit<CanvasItem, 'id' | 'x' | 'y' | 'w' | 'h'>): string | null {
    const card = this.pending.find((pending) => pending.id === cardId)
    if (!card?.jobId || !card.transient) return null
    const natW = item.naturalWidth
    const natH = item.naturalHeight
    const h = natW && natH ? Math.max(1, Math.round((card.w * natH) / natW)) : card.h
    const completed = this.completePendingResult(
      cardId,
      card.jobId,
      { ...item, id: cardId, x: card.x, y: card.y + card.h - h, w: card.w, h } as CanvasItem,
      { notify: true, publish: true, fresh: true },
    )
    return completed ? cardId : null
  }

  setPendingJob(pendingId: string, jobId: string): void {
    const current = this.pending.find((pending) => pending.id === pendingId)
    if (!current) return
    this.pending = this.pending.map((p) => (p.id === pendingId ? { ...p, jobId } : p))
    this.notifyContent()
    if (current.transient) return
    const patches = patchWithInverse(current, { jobId })
    this.commitMutation(
      { type: 'pending.patch', objectId: pendingId, payload: patches.forward },
      { type: 'pending.patch', objectId: pendingId, payload: patches.inverse },
    )
  }

  /**
   * Задача переезжает на номер сервера команды — вместе с ней и её карточка.
   *
   * ⚠️ Карточку ищем и по её СОБСТВЕННОМУ номеру (`placeholderId`), а не только
   * по номеру задачи. Номер задачи нашего сервера на общую доску не едет, и
   * свежий снимок после переподключения стирает его с карточки. На серии
   * генераций окно для этого широкое: наш сервер ведёт не больше трёх задач
   * разом, и четвёртая узнаёт номер сервера команды, только когда освободится
   * место. Карточка без номера оставалась крутиться, а готовый результат
   * вставал копией рядом с ней (жалоба 30.09.2026).
   */
  updatePendingJobId(oldJobId: string, newJobId: string, placeholderId?: string): void {
    const bound = this.pending.filter((candidate) => candidate.jobId === oldJobId)
    for (const pending of bound) {
      this.updatePending(pending.id, { jobId: newJobId }, { system: true })
    }
    if (bound.length > 0) return
    const card = this.adoptablePending(placeholderId, newJobId)
    if (card && card.jobId !== newJobId) this.updatePending(card.id, { jobId: newJobId }, { system: true })
  }

  /**
   * Карточка, в которую запущена задача, если её можно отдать этой задаче:
   * она свободна (номера нет или он `local:` — «задачи на сервере нет») либо
   * уже отдана ей. Правило то же, что у сервера команды (`freeFor` в
   * jobBoardDelivery): карточку, занятую ДРУГОЙ задачей (повтор), не трогаем.
   * Карточки своей работы (`transient`) — не генерации, их не отдаём никогда.
   */
  private adoptablePending(placeholderId: string | undefined, jobId: string): Placeholder | undefined {
    if (!placeholderId) return undefined
    const card = this.pending.find((pending) => pending.id === placeholderId)
    if (!card || card.transient) return undefined
    const free = !card.jobId || card.jobId.startsWith('local:') || card.jobId === jobId
    return free ? card : undefined
  }

  updatePending(id: string, patch: Partial<Placeholder>, options: { system?: boolean } = {}): void {
    const current = this.pending.find((pending) => pending.id === id)
    if (!current) return
    if (!options.system && !this.canMutateItems([id])) return
    this.pending = this.pending.map((p) => (p.id === id ? { ...p, ...patch } : p))
    this.notifyContent()
    if (current.transient) return
    const patches = patchWithInverse(current, patch)
    this.commitMutation(
      { type: 'pending.patch', objectId: id, payload: patches.forward },
      { type: 'pending.patch', objectId: id, payload: patches.inverse },
    )
  }

  // Повтор упавшей задачи ПРЯМО В ЭТОЙ карточке: она снова крутится на своём
  // месте, а не создаётся новой где-то рядом. Счётчик секунд начинается заново.
  restartPending(id: string, jobId: string): void {
    if (!this.pending.some((p) => p.id === id)) return
    this.updatePending(id, {
      jobId, status: 'loading', error: undefined, startedAt: Date.now(),
    })
  }

  dismissPendingById(id: string): void {
    const current = this.pending.find((pending) => pending.id === id)
    if (!current) return
    if (!current.transient && !this.canMutateItems([id])) return
    this.pending = this.pending.filter((p) => p.id !== id)
    this.notifyContent()
    if (current.transient) return
    this.commitMutation(
      { type: 'pending.delete', objectId: id, payload: {} },
      { type: 'pending.add', objectId: id, payload: current },
    )
  }

  // задача упала — карточка краснеет с текстом ошибки. true, если заглушка нашлась.
  // Карточку, потерявшую номер задачи, находим по её собственному номеру (см.
  // updatePendingJobId) и заодно возвращаем ей номер — по нему живёт «Повторить».
  failPendingByJob(jobId: string, error: string, placeholderId?: string): boolean {
    const p = this.pending.find((x) => x.jobId === jobId)
    if (p) {
      this.updatePending(p.id, { status: 'error', error }, { system: true })
      return true
    }
    const card = this.adoptablePending(placeholderId, jobId)
    if (!card) return false
    this.updatePending(card.id, { jobId, status: 'error', error }, { system: true })
    return true
  }

  failPendingById(id: string, error: string): boolean {
    if (!this.pending.some((p) => p.id === id)) return false
    this.updatePending(id, { status: 'error', error }, { system: true })
    return true
  }

  // результат готов → заменяем заглушку реальным объектом НА ЕЁ МЕСТЕ (низ ряда
  // сохраняется: y = низ_заглушки − реальная_высота). Нет заглушки (напр. из
  // нод) — прежнее поведение placeResult. Если заглушку успели удалить, paid
  // результат не воскрешает её на доске: он остаётся в центре задач.
  //
  // Для общей доски завершение — одна логическая команда pending.complete.
  // Поэтому pending и item меняются атомарно, а id pending сохраняется и для
  // selection, и для server-side idempotency.
  private completePendingResult(
    pendingId: string,
    jobId: string | undefined,
    item: CanvasItem,
    options: { notify: boolean; publish: boolean; fresh: boolean },
  ): boolean {
    const current = this.pending.find((pending) => pending.id === pendingId && pending.jobId === jobId)
    if (!current) return false

    // Кадр/скетч собран в этой вкладке, серверной задачи для него нет.
    // Временная карточка остаётся локальной, готовый asset — обычный item.add.
    if (current.transient) this.capture()

    const completed = { ...item, id: pendingId }
    const wasSelected = this.selected.has(pendingId)
    this.pending = this.pending.filter((pending) => pending.id !== pendingId)
    // A duplicate completion must be idempotent. Filtering first also keeps an
    // old optimistic copy from creating two objects with the same logical id.
    this.items = [
      ...this.items.filter((candidate) => candidate.id !== pendingId),
      completed,
    ]
    this.archive = this.archive.filter((candidate) => candidate.id !== pendingId)
    if (wasSelected) this.selected.add(pendingId)
    else this.selected.delete(pendingId)
    if (options.fresh) this.freshIds.add(pendingId)
    this.lastRect = { x: completed.x, y: completed.y, w: completed.w, h: completed.h }

    if (options.notify) this.notifyContent()
    if (options.publish) {
      if (current.transient) {
        this.commitMutation(
          { type: 'item.add', objectId: pendingId, payload: completed },
          { type: 'item.delete', objectId: pendingId, payload: {} },
        )
        return true
      }
      // Без номера задачи завершение наружу не уходит: серверу нечего сверять.
      if (!jobId) return true
      this.commitMutation(
        {
          type: 'pending.complete',
          objectId: pendingId,
          payload: { pendingId, jobId, item: completed },
        },
        null,
      )
    }
    return true
  }

  /** Длительность и волна догоняют объект: он должен появиться сразу, а не
   *  ждать ни чтения метаданных, ни ffmpeg. Шагом истории это НЕ становится —
   *  иначе первый Ctrl+Z отменял бы появление волны, а не саму генерацию. */
  private async attachAudioDetails(itemId: string, src: string): Promise<void> {
    try {
      const duration = await probeAudioDuration(src)
      if (duration !== undefined) this.updateItem(itemId, { duration }, false)
    } catch {
      // Длительность необязательна: плашка покажет прочерк.
    }
    try {
      const { peaks } = await api.audioPeaks(src)
      if (peaks && peaks.length > 0) this.updateItem(itemId, { peaks }, false)
    } catch {
      // Без ffmpeg волны не будет — плашка нарисуется полосой.
    }
  }

  async resolveJob(jobId: string, result: JobResult, name: string, options: ResolveJobOptions = {}): Promise<void> {
    const { cloudJobId } = options
    // ⚠️ Ту же работу сервер команды знает под СВОИМ номером, и результат
    // сетевой доски теперь ставит он сам (пункт 3.7): объект может уже стоять
    // с `sourceJobId: cloud-job~<доска>~<его номер>`, пока приложение следит
    // за задачей под номером нашего сервера. Без этой сверки встал бы второй.
    const sameJob = (candidate: string | undefined): boolean => candidate === jobId
      || Boolean(cloudJobId && candidate?.startsWith('cloud-job~') && candidate.endsWith(`~${cloudJobId}`))
    const alreadyPlaced = (): boolean => this.items.some((item) => sameJob(item.sourceJobId))
      || this.archive.some((item) => sameJob(item.sourceJobId))
    const pendingAtStart = this.pending.find((pending) => pending.jobId === jobId)
    // Местный результат существует только вместе со своей заглушкой. После
    // завершения или отмены повторный callback не должен воскрешать объект.
    if (jobId.startsWith('local:') && !pendingAtStart) return
    const pendingId = pendingAtStart?.id
    const hadPending = pendingAtStart != null
    const currentPending = (): Placeholder | undefined => (
      pendingId
        ? this.pending.find((pending) => pending.id === pendingId && pending.jobId === jobId)
        : undefined
    )

    const existingItem = this.items.find((item) => sameJob(item.sourceJobId))
    const existingArchive = this.archive.find((item) => sameJob(item.sourceJobId))
    if (existingItem || existingArchive) {
      // A completion can be observed twice after reconnect. If the pending
      // row is still around, converge it through the same atomic operation;
      // never route this cleanup through the user-facing dismiss action.
      if (existingItem && pendingAtStart) {
        this.completePendingResult(pendingAtStart.id, jobId, existingItem, {
          notify: true, publish: true, fresh: false,
        })
      }
      // Звук, поставленный сервером, приходит без длительности и волны: их
      // считает приложение (ffmpeg живёт здесь). Досчитываем один раз.
      if (existingItem?.kind === 'audio' && existingItem.duration === undefined && existingItem.src
        && !this.audioDetailsRequested.has(existingItem.id)) {
        this.audioDetailsRequested.add(existingItem.id)
        void this.attachAudioDetails(existingItem.id, existingItem.src)
      }
      return
    }

    const sourceJobId = jobId.startsWith('local:') ? undefined : jobId
    if (!result.url) {
      const p = currentPending()
      // The user deleted/cancelled this row while an earlier delivery was in
      // flight. Keep the paid output in the task centre instead of reviving it.
      if (hadPending && !p) return
      if (!result.text) return
      if (!p) {
        this.placeText(result.text, undefined, sourceJobId)
        return
      }
      const fontSize = DEFAULT_FONT_SIZE
      const dims = computeAdaptiveTextDimensions(result.text, fontSize, p.w)
      const h = Math.max(40, dims.h)
      this.completePendingResult(
        p.id,
        jobId,
        {
          id: p.id,
          kind: 'text',
          x: p.x,
          y: p.y + p.h - h,
          w: p.w,
          h,
          text: result.text,
          fontSize,
          name: 'text',
          prompt: p.prompt,
          modelId: p.modelId,
          referenceIds: p.referenceIds,
          sourceJobId,
          sourceLaunch: p.launch,
        },
        { notify: true, publish: true, fresh: true },
      )
      return
    }
    const mime = result.mime ?? 'image/jpeg'
    const isVideo = mime.startsWith('video/')
    const isAudio = mime.startsWith('audio/')
    // Cloud уже сохранил файл и прислал его размеры. Не держим готовую
    // заглушку на экране, пока браузер повторно скачивает оригинал целиком:
    // экранное превью начнёт грузиться сразу после появления item.
    // Звук становится плашкой на месте заглушки: размеров у него нет, зато
    // есть длительность и волна — их дочитываем ПОСЛЕ появления объекта, чтобы
    // результат не ждал ни сети, ни ffmpeg.
    if (isAudio) {
      const p = currentPending()
      if (hadPending && !p) return
      if (!p) {
        const id = this.addItem(
          {
            kind: 'audio',
            x: 0,
            y: 0,
            w: AUDIO_ITEM_WIDTH,
            h: AUDIO_ITEM_HEIGHT,
            src: result.url,
            assetId: result.assetId,
            assetRevision: result.assetRevision,
            assetChecksum: result.assetChecksum,
            mime,
            name,
            prompt: options.prompt,
            modelId: options.modelId,
            sourceJobId,
          },
          { select: true, fresh: true },
        )
        void this.attachAudioDetails(id, result.url)
        return
      }
      const rect = p ?? { x: 0, y: 0, w: AUDIO_ITEM_WIDTH, h: AUDIO_ITEM_HEIGHT }
      const completed = this.completePendingResult(
        p.id,
        jobId,
        {
          id: p.id,
          kind: 'audio',
          x: rect.x,
          y: rect.y + rect.h - AUDIO_ITEM_HEIGHT,
          w: AUDIO_ITEM_WIDTH,
          h: AUDIO_ITEM_HEIGHT,
          src: result.url,
          assetId: result.assetId,
          assetRevision: result.assetRevision,
          assetChecksum: result.assetChecksum,
          mime,
          name,
          prompt: p.prompt,
          modelId: p.modelId,
          referenceIds: p.referenceIds,
          sourceJobId,
        },
        { notify: true, publish: true, fresh: true },
      )
      if (completed) void this.attachAudioDetails(p.id, result.url)
      return
    }
    // размеры берём из самого файла: fal (особенно GPT Image) не всегда отдаёт
    // width/height. Декодированный размер всегда побеждает провайдерскую пару;
    // при сбое/таймауте берём только валидные конечные положительные API-размеры.
    let size: { width: number; height: number }
    if (isVideo) {
      size = result.width && result.height
        ? { width: result.width, height: result.height }
        : await probeVideoSize(result.url)
    } else if (pendingAtStart?.transient && result.width && result.height) {
      size = { width: result.width, height: result.height }
    } else {
      const probed = await probeGeneratedImageSize(result.url, {
        apiWidth: result.width,
        apiHeight: result.height,
      })
      if (!probed) {
        const failing = currentPending()
        if (failing) {
          this.failPendingById(failing.id, DELIVERY_IMAGE_DIMENSIONS_FAILED)
        } else {
          throw new Error(DELIVERY_IMAGE_DIMENSIONS_FAILED)
        }
        return
      }
      size = probed
    }
    const natW = size.width
    const natH = size.height
    const p = currentPending()
    // The pending row existed when delivery started but disappeared while the
    // media dimensions were being probed. Do not resurrect a deleted row.
    if (hadPending && !p) return
    if (!p) {
      // ⚠️ Пока мерили файл, результат мог поставить сервер команды (он ставит
      // его сам, пункт 3.7). Сверка в начале этого не видела — без повторной
      // встал бы второй объект рядом с его.
      if (alreadyPlaced()) return
      this.placeMedia({ kind: isVideo ? 'video' : 'image', src: result.url, assetId: result.assetId, assetRevision: result.assetRevision, assetChecksum: result.assetChecksum,
        mime, name, naturalW: natW, naturalH: natH, prompt: options.prompt, modelId: options.modelId, sourceJobId })
      return
    }
    // Высоту НЕ подпираем снизу: картинка обязана сохранить пропорции файла.
    // Подпорка в 40 писалась под заглушку генерации шириной 440 и там не
    // срабатывала никогда, а кадр с крохотного ролика она бы растянула.
    const h = Math.max(1, Math.round((p.w * natH) / natW))
    const bottom = p.y + p.h
    const completedItem: CanvasItem = {
      id: p.id,
      kind: isVideo ? 'video' : 'image',
      x: p.x,
      y: bottom - h,
      w: p.w,
      h,
      src: result.url,
      assetId: result.assetId,
      assetRevision: result.assetRevision,
      assetChecksum: result.assetChecksum,
      mime,
      name,
      prompt: p.prompt,
      modelId: p.modelId,
      referenceIds: p.referenceIds,
      sourceJobId,
      sourceLaunch: p.launch,
      naturalWidth: natW,
      naturalHeight: natH,
    }
    const completed = this.completePendingResult(
      p.id,
      jobId,
      completedItem,
      { notify: true, publish: true, fresh: true },
    )
  }

  pinAsset(asset: PinnedAsset): void {
    const previous = this.assets.find((candidate) => candidate.slot === asset.slot)
    this.assets = [...this.assets.filter((a) => a.slot !== asset.slot), asset]
    this.notifyContent()
    this.commitMutation(
      { type: 'asset.pin', objectId: `asset-slot-${asset.slot}`, payload: asset },
      previous
        ? { type: 'asset.pin', objectId: `asset-slot-${asset.slot}`, payload: previous }
        : { type: 'asset.unpin', objectId: `asset-slot-${asset.slot}`, payload: { slot: asset.slot } },
    )
    reportOnboardingSuccess('save-for-later')
  }

  unpinAsset(slot: number): void {
    const previous = this.assets.find((asset) => asset.slot === slot)
    if (!previous) return
    this.assets = this.assets.filter((a) => a.slot !== slot)
    this.notifyContent()
    this.commitMutation(
      { type: 'asset.unpin', objectId: `asset-slot-${slot}`, payload: { slot } },
      { type: 'asset.pin', objectId: `asset-slot-${slot}`, payload: previous },
    )
  }

  // ── архив доски (материал убран с холста, но не потерян) ──
  getArchive = (): ArchivedItem[] => this.archive
  getArchivedItem = (id: string): ArchivedItem | undefined => this.archive.find((a) => a.id === id)
  getArchivedItems = (ids: string[]): ArchivedItem[] => {
    const set = new Set(ids)
    return this.archive.filter((a) => set.has(a.id))
  }

  // Убрать объекты с холста в архив. Один шаг истории — Ctrl+Z возвращает всё
  // обратно (архив входит в снапшот, см. history.ts).
  archiveItems(ids: string[]): number {
    const set = new Set(ids)
    const moving = this.items.filter((i) => set.has(i.id))
    if (moving.length === 0) return 0
    if (!this.canMutateItems(moving.map((item) => item.id))) return 0
    const beforeImports = this.activeLinkImportIds(this.items)
    this.capture()
    const at = Date.now()
    this.items = this.items.filter((i) => !set.has(i.id))
    const archived = moving.map((item) => toArchived(
      item.kind === 'link' && item.link
        ? { ...item, link: { ...item.link, activeImportId: undefined } }
        : item,
      at,
    ))
    this.archive = [...this.archive, ...archived]
    this.cancelRemovedLinkImports(beforeImports, this.activeLinkImportIds(this.items))
    this.selected = new Set([...this.selected].filter((id) => !set.has(id)))
    this.notifyContent()
    this.commitMutationBatch(archived.map((entry, index) => ({
      mutation: { type: 'archive.add', objectId: entry.id, payload: entry } as CanvasMutation,
      inverse: { type: 'archive.restore', objectId: entry.id, payload: moving[index]! } as CanvasMutation,
    })))
    reportOnboardingSuccess('save-for-later')
    return moving.length
  }

  // Вернуть на холст: объект встаёт туда, откуда его забрали (занято — сдвиг
  // вправо, как у обычного результата), становится выделением и подсвечивается.
  restoreArchived(ids: string[]): string[] {
    const set = new Set(ids)
    const back = this.archive.filter((a) => set.has(a.id))
    if (back.length === 0) return []
    if (!this.canMutateItems(back.map((item) => item.id))) return []
    this.capture()
    this.archive = this.archive.filter((a) => !set.has(a.id))
    const restoredIds: string[] = []
    const batch: Array<{ mutation: CanvasMutation; inverse: CanvasMutation }> = []
    for (const entry of back) {
      const item = toCanvasItem(entry)
      // id теоретически мог занять другой объект (дубль/вставка) — тогда новый
      const id = this.items.some((i) => i.id === item.id) ? uid() : item.id
      const { x, y } = this.nextPosition(item.w, item.h, { x: item.x, y: item.y })
      this.items = [...this.items, { ...item, id, x, y }]
      this.freshIds.add(id)
      restoredIds.push(id)
      const restored = { ...item, id, x, y }
      batch.push({
        mutation: { type: 'archive.restore', objectId: id, payload: restored },
        inverse: { type: 'archive.add', objectId: id, payload: { ...entry, id } },
      })
    }
    this.commitMutationBatch(batch)
    this.selected = new Set(restoredIds)
    if (this.collaboration) void this.collaboration.requestSelection(restoredIds)
    const box = this.bbox(restoredIds)
    if (box) this.ensureVisible(box)
    this.notifyContent()
    return restoredIds
  }

  // Удалить из архива насовсем (файл в media/ потом подберёт сборщик мусора).
  // Тоже шаг истории: случайное нажатие не должно стоить материала.
  removeArchived(ids: string[]): number {
    const set = new Set(ids)
    const doomed = this.archive.filter((a) => set.has(a.id))
    if (doomed.length === 0) return 0
    if (!this.canMutateItems(doomed.map((item) => item.id))) return 0
    this.capture()
    this.archive = this.archive.filter((a) => !set.has(a.id))
    this.notifyContent()
    this.commitMutationBatch(doomed.map((entry) => ({
      mutation: { type: 'archive.delete', objectId: entry.id, payload: {} } as CanvasMutation,
      inverse: { type: 'archive.add', objectId: entry.id, payload: entry } as CanvasMutation,
    })))
    return doomed.length
  }

  // ── сериализация ────────────────────────────────────────
  toDoc(): CanvasDoc {
    const pending = this.pending.filter(
      (p) => !p.transient && Boolean(p.jobId) && !p.jobId?.startsWith('macro:'),
    ).map((p) => ({ ...p, retry: persistableRetry(p.retry) }))
    return {
      version: 1,
      items: this.items,
      camera: this.savedCamera,
      assets: this.assets,
      archive: this.archive,
      pending,
      ...(this.handledGenerationLaunchIds.length > 0
        ? { handledGenerationLaunchIds: [...this.handledGenerationLaunchIds] }
        : {}),
    }
  }

  loadDoc(doc: CanvasDoc | null | undefined): void {
    this.arrangePreview = null
    if (doc && Array.isArray(doc.items)) {
      this.items = doc.items.map((i) => ({ ...i }))
      this.camera = { ...(doc.camera ?? { x: 0, y: 0, scale: 1 }) }
      this.savedCamera = { ...this.camera }
      this.assets = Array.isArray(doc.assets) ? doc.assets.map((a) => ({ ...a })) : []
      this.archive = sanitizeArchive(doc.archive)
      this.pending = Array.isArray(doc.pending) ? doc.pending.map((p) => ({ ...p })) : []
      this.handledGenerationLaunchIds = normalizeHandledGenerationLaunchIds(doc.handledGenerationLaunchIds)
    } else {
      this.items = [...EMPTY_DOC.items]
      this.camera = { ...EMPTY_DOC.camera }
      this.savedCamera = { ...EMPTY_DOC.camera }
      this.assets = []
      this.archive = []
      this.pending = []
      this.handledGenerationLaunchIds = []
    }
    this.selected = new Set()
    this.strokes = []
    this.strokeRedo = []
    this.lastRect = null
    this.guides = []
    // «Свежесть» и отложенный фокус онбординга принадлежали ПРЕЖНЕЙ доске —
    // не тянем их на новую (анимация не стреляла бы, но состояние текло)
    this.freshIds.clear()
    this.deliveredAgentResultIds.clear()
    if (this.onboardingFocusTimer !== null) {
      window.clearTimeout(this.onboardingFocusTimer)
      this.onboardingFocusTimer = null
    }
    const hadGenerationFocus = this.generationFocus.length > 0
    this.generationFocus = []
    this.history.clear()
    this.notifyContent(false)
    this.notifyCamera()
    if (hadGenerationFocus) this.notifyGenerationFocus()
  }

  // ── скетч ───────────────────────────────────────────────
  startStroke(color: string, size: number, x: number, y: number, tool: 'draw' | 'erase' = 'draw'): void {
    this.strokeRedo = []
    this.strokes = [...this.strokes, { color, size, tool, points: [x, y] }]
    this.notifyContent(false)
  }
  extendStroke(x: number, y: number): void {
    if (this.strokes.length === 0) return
    const last = this.strokes[this.strokes.length - 1]
    const updated = { ...last, points: [...last.points, x, y] }
    this.strokes = [...this.strokes.slice(0, -1), updated]
    this.notifyContent(false)
  }
  clearStrokes(): void {
    if (this.strokes.length === 0 && this.strokeRedo.length === 0) return
    this.strokes = []
    this.strokeRedo = []
    this.notifyContent(false)
  }
  canUndoStroke(): boolean {
    return this.strokes.length > 0
  }
  canRedoStroke(): boolean {
    return this.strokeRedo.length > 0
  }
  undoStroke(): boolean {
    const stroke = this.strokes.at(-1)
    if (!stroke) return false
    this.strokes = this.strokes.slice(0, -1)
    this.strokeRedo = [...this.strokeRedo, stroke]
    this.notifyContent(false)
    return true
  }
  redoStroke(): boolean {
    const stroke = this.strokeRedo.at(-1)
    if (!stroke) return false
    this.strokeRedo = this.strokeRedo.slice(0, -1)
    this.strokes = [...this.strokes, stroke]
    this.notifyContent(false)
    return true
  }

  // ── размещение результатов ──────────────────────────────
  private nextPosition(w: number, h: number, startPos?: { x: number; y: number }): { x: number; y: number } {
    let startX: number
    let startY: number
    if (startPos) {
      startX = startPos.x
      startY = startPos.y
    } else if (this.lastRect) {
      startX = this.lastRect.x + this.lastRect.w + GAP
      startY = this.lastRect.y
    } else {
      const c = this.getViewportCenter()
      startX = c.x - w / 2
      startY = c.y - h / 2
    }

    let x = startX
    const y = startY
    let overlap = true
    const maxAttempts = 100
    let attempts = 0
    while (overlap && attempts < maxAttempts) {
      attempts++
      overlap = false
      const currentRect = { x, y, w, h }
      
      const overlappingItem = this.items.find((item) => rectIntersects(currentRect, item))
      if (overlappingItem) {
        x = overlappingItem.x + overlappingItem.w + GAP
        overlap = true
        continue
      }
      
      const overlappingPending = this.pending.find((p) => rectIntersects(currentRect, p))
      if (overlappingPending) {
        x = overlappingPending.x + overlappingPending.w + GAP
        overlap = true
        continue
      }
    }
    return { x, y }
  }

  placeMedia(
    media: { kind: 'image' | 'video' | 'audio'; src: string; assetId?: string; assetRevision?: number; assetChecksum?: string; mime: string; name: string; naturalW: number; naturalH: number; prompt?: string; modelId?: string; duration?: number; peaks?: number[]; externalEditSessionId?: string; sourceJobId?: string },
    at?: { x: number; y: number },
  ): string {
    // У звука натуральных размеров нет — плашка всегда одного размера
    // (см. audioMeta), а пропорции картинки/видео считаются от исходника.
    const isAudio = media.kind === 'audio'
    const w = isAudio ? AUDIO_ITEM_WIDTH : DISPLAY_WIDTH
    const h = isAudio
      ? AUDIO_ITEM_HEIGHT
      : Math.max(40, Math.round((DISPLAY_WIDTH * media.naturalH) / media.naturalW))
    const { x, y } = this.nextPosition(w, h, at)
    const id = this.addItem(
      isAudio
        ? { kind: 'audio', x, y, w, h, src: media.src, assetId: media.assetId, assetRevision: media.assetRevision, assetChecksum: media.assetChecksum, mime: media.mime, name: media.name, prompt: media.prompt, modelId: media.modelId, duration: media.duration, peaks: media.peaks, sourceJobId: media.sourceJobId }
        : { kind: media.kind, x, y, w, h, src: media.src, assetId: media.assetId, assetRevision: media.assetRevision, assetChecksum: media.assetChecksum, mime: media.mime, name: media.name, naturalWidth: media.naturalW, naturalHeight: media.naturalH, prompt: media.prompt, modelId: media.modelId, externalEditSessionId: media.externalEditSessionId, sourceJobId: media.sourceJobId },
      { select: true, fresh: true },
    )
    // если объект вне видимой области — мягко подвинем камеру к нему
    const s = this.camera.scale
    const sx = x * s + this.camera.x
    const sy = y * s + this.camera.y
    const outside = sx < 0 || sy < 0 || sx + w * s > this.container.w || sy + h * s > this.container.h
    if (outside) this.centerOn(x + w / 2, y + h / 2)
    return id
  }

  // at — центр (мировые координаты), напр. клик правой кнопкой по пустому
  // месту; без at — обычная лента результатов (nextPosition)
  placeText(text: string, at?: { x: number; y: number }, sourceJobId?: string): string {
    let fontSize = DEFAULT_FONT_SIZE
    if (!text) {
      // Подбираем такой кегль, чтобы текст казался размером ~32px на текущем зуме (чтобы было видно)
      const visualSize = 32
      fontSize = Math.max(DEFAULT_FONT_SIZE, Math.round(visualSize / this.camera.scale))
      fontSize = Math.min(fontSize, 1000) // разумный предел
    }
    const dims = computeAdaptiveTextDimensions(text, fontSize)
    const w = dims.w
    const h = dims.h
    const pos = at ? { x: at.x - w / 2, y: at.y - h / 2 } : this.nextPosition(w, h)
    return this.addItem({ kind: 'text', x: pos.x, y: pos.y, w, h, text, fontSize, name: 'text', sourceJobId }, { select: true })
  }

  autoFitText(id: string): void {
    const item = this.getItem(id)
    if (!item || item.kind !== 'text' || !item.text) return
    const fontSize = item.fontSize ?? DEFAULT_FONT_SIZE
    const dims = computeAdaptiveTextDimensions(item.text, fontSize, item.w)
    this.updateItem(id, { w: dims.w, h: dims.h })
  }

  async placeResult(result: JobResult, name: string): Promise<void> {
    if (!result.url) {
      if (result.text) this.placeText(result.text)
      return
    }
    const mime = result.mime ?? 'image/jpeg'
    if (mime.startsWith('video/')) {
      const size =
        result.width && result.width > 0
          ? { width: result.width, height: result.height ?? 576 }
          : await probeVideoSize(result.url)
      this.placeMedia({ kind: 'video', src: result.url, assetId: result.assetId, assetRevision: result.assetRevision, assetChecksum: result.assetChecksum, mime, name, naturalW: size.width, naturalH: size.height, prompt: `Macro: ${name}` })
    } else {
      // размеры читаем из файла (см. resolveJob) — не из ненадёжных серверных
      const size = await probeImageSize(result.url)
      this.placeMedia({ kind: 'image', src: result.url, assetId: result.assetId, assetRevision: result.assetRevision, assetChecksum: result.assetChecksum, mime, name, naturalW: size.width, naturalH: size.height, prompt: `Macro: ${name}` })
    }
  }

  // версия из внешнего редактора встаёт рядом с исходной картинкой
  placeImageNear(
    anchorId: string,
    image: { assetId?: string; assetRevision?: number; assetChecksum?: string; url: string; mime: string; width: number; height: number },
    name: string,
  ): string {
    const anchor = this.getItem(anchorId)
    const at = anchor ? { x: anchor.x + anchor.w + GAP, y: anchor.y } : undefined
    return this.placeMedia(
      { kind: 'image', src: image.url, assetId: image.assetId, assetRevision: image.assetRevision, assetChecksum: image.assetChecksum, mime: image.mime, name, naturalW: image.width, naturalH: image.height },
      at,
    )
  }

  placeExternalEditImage(
    anchorId: string,
    // ⚠️ assetId — для командной доски: там надёжная ссылка одна, а src лишь
    // локальный адрес для показа. У личной доски его нет и быть не должно.
    image: { url: string; mime: string; width: number; height: number; assetId?: string; assetRevision?: number; assetChecksum?: string },
    name: string,
    sessionId: string,
  ): string {
    const anchor = this.getItem(anchorId)
    const at = anchor ? { x: anchor.x + anchor.w + GAP, y: anchor.y } : undefined
    return this.placeMedia(
      {
        kind: 'image',
        src: image.url,
        assetId: image.assetId,
        assetRevision: image.assetRevision,
        assetChecksum: image.assetChecksum,
        mime: image.mime,
        name,
        naturalW: image.width,
        naturalH: image.height,
        externalEditSessionId: sessionId,
      },
      at,
    )
  }

  updateImageItem(
    id: string,
    image: { url: string; width: number; height: number; assetId?: string; assetRevision?: number; assetChecksum?: string },
  ): void {
    const item = this.getItem(id)
    if (!item) return
    const w = item.w || DISPLAY_WIDTH
    const h = Math.max(40, Math.round((w * image.height) / image.width))
    this.updateItem(id, {
      src: image.url,
      ...(image.assetId ? { assetId: image.assetId } : {}),
      ...(image.assetRevision !== undefined ? { assetRevision: image.assetRevision } : {}),
      ...(image.assetChecksum ? { assetChecksum: image.assetChecksum } : {}),
      w,
      h,
      naturalWidth: image.width,
      naturalHeight: image.height,
      crop: undefined,
    })
  }

  // добавить импортированный файл в точке (мировые координаты)
  addImportedAt(
    file: { kind: 'image' | 'video'; src: string; mime: string; name: string; naturalW: number; naturalH: number },
    world: { x: number; y: number },
  ): string {
    const w = DISPLAY_WIDTH
    const h = Math.max(40, Math.round((DISPLAY_WIDTH * file.naturalH) / file.naturalW))
    return this.addImportedRect(file, { x: world.x - w / 2, y: world.y - h / 2, w, h })
  }

  /** Куски, нарезанные из клипа, — рядом с оригиналом одним рядом.
   *
   * Оригинал НЕ трогаем: он оплачен, и подменять его результатом резки
   * значило бы терять исходник ради правки, которую можно было и не угадать.
   * Один шаг истории на весь ряд — Ctrl+Z убирает нарезку целиком. */
  placeVideoPieces(
    source: CanvasItem,
    pieces: ReadonlyArray<{ url: string; mime: string; duration: number; width?: number; height?: number }>,
  ): string[] {
    if (pieces.length === 0) return []
    this.capture()
    const gap = 24
    const created: string[] = []
    let x = source.x
    const y = source.y + source.h + gap
    for (const [index, piece] of pieces.entries()) {
      const ratio = piece.width && piece.height ? piece.width / piece.height : source.w / source.h
      const h = source.h
      const w = Math.max(40, h * ratio)
      const id = this.addItem(
        {
          kind: 'video',
          x,
          y,
          w,
          h,
          src: piece.url,
          mime: piece.mime,
          naturalWidth: piece.width,
          naturalHeight: piece.height,
          name: `${source.name ?? 'clip'} — ${index + 1}`,
          referenceIds: [source.id],
        },
        { select: false, captureHistory: false },
      )
      created.push(id)
      x += w + gap
    }
    this.setSelection(created)
    return created
  }

  addImportedRect(
    file: {
      kind: 'image' | 'video' | 'audio'
      src: string
      mime: string
      name: string
      naturalW: number
      naturalH: number
      // только для звука: натуральных размеров у него нет, зато есть длительность
      duration?: number
      assetId?: string
      assetRevision?: number
      assetChecksum?: string
    },
    rect: { x: number; y: number; w: number; h: number },
    select = true,
  ): string {
    const base = {
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      src: file.src, assetId: file.assetId, mime: file.mime, name: file.name,
      assetRevision: file.assetRevision,
      assetChecksum: file.assetChecksum,
    }
    if (file.kind === 'audio') {
      return this.addItem({ kind: 'audio', ...base, duration: file.duration }, { select })
    }
    return this.addItem(
      { kind: file.kind, ...base, naturalWidth: file.naturalW, naturalHeight: file.naturalH },
      { select },
    )
  }
}

export type { ItemKind }
