import { api, ApiError } from '../../api'
import { DELIVERY_IMAGE_DIMENSIONS_FAILED } from './konva/mediaProbe'
import { isLostLocalLaunch, isOrphanedLaunch, LOST_LOCAL_LAUNCH, ORPHANED_LAUNCH } from './pendingLaunchState'
import type { CanvasStore } from './konva/canvasStore'
import type { CanvasDoc } from './konva/types'
import { createSaveStatusScope, type SaveStatusScope } from './saveStatusBus'
import {
  restoreGenerationTask,
  trackGeneration,
  type GenerationRegistry,
  type RestoredGenerationTask,
} from './generationRegistry'
import {
  createProjectConflictSnapshot,
  parseProjectConflictError,
  type ProjectConflictSnapshot,
} from './projectConflict'
import { trackMediaImport } from './mediaImportRegistry'
import type { MediaImportTask } from './mediaImportTypes'
import { newId } from '../../ui/ids'
import {
  browserProjectRecoveryStorage,
  type ProjectRecoveryRecord,
  type ProjectRecoveryStorage,
} from './projectRecoveryStorage'
import { recoveryWorthSending } from './snapshotIdentity'
import { localSnapshotMediaError, missingLocalMediaError } from './localSnapshotValidation'

const SAVE_DEBOUNCE_MS = 800
// камера сохраняется ЛЕНИВЕЕ контента: каждый тик колеса/панорамы планировал
// полный снапшот через 800 мс — на больших досках это лишняя работа впустую
const CAMERA_DEBOUNCE_MS = 5000
// при смене доски/размонтировании ждём запись; сеть может мигнуть — несколько попыток
const FINAL_FLUSH_ATTEMPTS = 5
const FINAL_FLUSH_RETRY_MS = 400

function permanentLocalSnapshotError(error: unknown): Error | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null
  if (error.code !== 'MISSING_MEDIA' && error.code !== 'INVALID_SNAPSHOT') return null
  return new Error(
    error.message || "The snapshot contains inaccessible media files. Download the JSON and return the original files.",
  )
}

type ProjectGenerationRegistry = Pick<
  GenerationRegistry,
  'trackGeneration' | 'restoreGenerationTask'
>

const browserGenerationRegistry: ProjectGenerationRegistry = {
  trackGeneration,
  restoreGenerationTask,
}

export function restoreProjectGenerationTasks(
  store: CanvasStore,
  projectId: string,
  registry: ProjectGenerationRegistry = browserGenerationRegistry,
  options: { repairLocalFailures?: boolean; now?: number } = {},
): void {
  const target = { kind: 'canvas' as const, projectId }
  const mediaImports = new Map<string, MediaImportTask>()
  const now = options.now ?? Date.now()
  for (const pending of store.getPending()) {
    // Карточку без номера задачи никто не завершит: запустившая её вкладка
    // закрылась раньше, чем номер пришёл. Красим её сбоем, чтобы её можно было
    // убрать; на планшете — только показом (см. BoardItemView), как и у
    // потерянного местного запуска ниже.
    if (isOrphanedLaunch(pending, now)) {
      if (options.repairLocalFailures !== false) store.failPendingById(pending.id, ORPHANED_LAUNCH)
      continue
    }
    if (!pending.jobId || pending.jobId.startsWith('macro:')) continue
    // Скачивание по ссылке приносит только картинки и видео: со звуком его
    // карточка работать не умеет, а заглушка звука сюда попасть может только
    // от генерации — там свой путь восстановления, ниже.
    if (pending.taskType === 'media-import' && pending.kind !== 'audio' && pending.sourceLinkId && pending.importEntryId) {
      const link = store.getItem(pending.sourceLinkId)?.link
      if (!link) continue
      const existing = mediaImports.get(pending.jobId) ?? {
        id: pending.jobId,
        sourceUrl: link.normalizedUrl || link.url,
        provider: link.provider,
        status: 'downloading',
        createdAt: pending.startedAt,
        updatedAt: pending.startedAt,
        items: [],
      }
      existing.items.push({
        id: pending.importEntryId,
        kind: pending.kind,
        title: pending.label,
        aspectRatio: pending.w / pending.h,
        status: pending.status === 'loading' ? 'downloading' : 'error',
        downloadedBytes: pending.downloadedBytes ?? 0,
        totalBytes: pending.totalBytes,
        percent: pending.percent,
        stage: pending.stage,
        error: pending.error,
      })
      mediaImports.set(pending.jobId, existing)
      continue
    }
    if (isLostLocalLaunch(pending)) {
      // local: создаётся только для неудавшегося запуска. Старые версии могли
      // сохранить идентификатор отдельно от ошибки. Облачную чужую карточку
      // показываем как сбой, не отправляя системную правку от другого устройства.
      if (options.repairLocalFailures !== false) store.failPendingByJob(pending.jobId, LOST_LOCAL_LAUNCH)
      registry.restoreGenerationTask({ jobId: pending.jobId, jobKind: pending.kind, target,
        state: 'error', error: LOST_LOCAL_LAUNCH, launch: pending.launch, createdAt: pending.startedAt })
      continue
    }
    if (pending.status === 'loading' || pending.error === DELIVERY_IMAGE_DIMENSIONS_FAILED) {
      if (!pending.jobId.startsWith('local:')) {
        registry.trackGeneration(
          // Карточка известна — пусть задача помнит её номер (см. GenerationTarget).
          { ...target, placeholderId: pending.id },
          pending.jobId,
          pending.kind,
          pending.retry,
          pending.launch,
        )
      }
      continue
    }
    const task: RestoredGenerationTask = {
      jobId: pending.jobId,
      jobKind: pending.kind,
      target,
      state: pending.error === 'Cancelled' || pending.error === 'отменено' ? 'cancelled' : 'error',
      error: pending.error,
      retry: pending.retry,
      launch: pending.launch,
      createdAt: pending.startedAt,
    }
    registry.restoreGenerationTask(task)
  }

  for (const task of mediaImports.values()) {
    if (!task.items.some((item) => item.status === 'downloading')) {
      task.status = 'error'
      task.error = "Failed to download media"
    }
    const linkId = store.getPending().find((pending) => pending.jobId === task.id)?.sourceLinkId
    if (linkId) trackMediaImport(projectId, linkId, task)
  }

  for (const item of [...store.getItems(), ...store.getArchive()]) {
    if (item.kind === 'link') continue
    if (!item.sourceJobId || item.sourceJobId.startsWith('local:')) continue
    registry.restoreGenerationTask({
      jobId: item.sourceJobId,
      jobKind: item.kind,
      target,
      state: 'done',
      launch: item.sourceLaunch,
      createdAt: item.sourceLaunch?.createdAt ?? 0,
    })
  }
}

export type ProjectLoadState = 'loading' | 'ready' | 'error' | 'conflict-saving' | 'conflict'

export interface ProjectSyncHandle {
  flushAndWait(): Promise<{ revision: number }>
  retryConflictRecovery(): Promise<ProjectConflictSnapshot>
  /**
   * Return an invalid local snapshot to the editable canvas. The durable
   * recovery record stays in place until a repaired document is confirmed by
   * the server, so choosing this action can never discard the JSON-only copy.
   */
  resumeInvalidSnapshot(): void
  dispose(): Promise<void>
}

// Один CanvasStore переживает смену доски и повторное открытие. Ответ старой
// async-загрузки поэтому нельзя отличить по самому store: нумеруем попытки и
// разрешаем им применять документ/состояние только пока они остаются текущими.
const projectLoadEpochs = new WeakMap<object, number>()

function nextProjectLoadEpoch(store: object): number {
  const epoch = (projectLoadEpochs.get(store) ?? 0) + 1
  projectLoadEpochs.set(store, epoch)
  return epoch
}

const STALE_PROJECT_LOAD_ERROR = new Error("Board load is stale")

function clearSavedRecovery(
  storage: ProjectRecoveryStorage,
  projectId: string,
  snapshot?: CanvasDoc,
  expectedRecord?: { updatedAt: number; snapshot: CanvasDoc },
) {
  const pending = storage.load(projectId)
  // A newer recovery record can belong to another tab. Keep it even when this
  // tab has just confirmed its own copy. Match both the timestamp and the
  // snapshot that this attempt actually wrote: two tabs can observe the same
  // Date.now() tick, and a timestamp alone would let one clear the other's
  // record. The latest snapshot may differ (for example after a camera-only
  // edit), so it is intentionally not used for this ownership check.
  if (pending && expectedRecord && (
    pending.updatedAt !== expectedRecord.updatedAt
    || JSON.stringify(pending.snapshot) !== JSON.stringify(expectedRecord.snapshot)
  )) {
    return { cleared: true, durable: true }
  }
  // Другая вкладка могла оставить более свежую правку, пока ждали ответ.
  // Удаляем только тот снимок, сохранение которого действительно подтверждено.
  if (pending && !expectedRecord && snapshot && JSON.stringify(pending.snapshot) !== JSON.stringify(snapshot)) {
    return { cleared: true, durable: true }
  }
  return storage.clear(projectId)
}

function staleProjectSyncHandle(saveStatusScope?: SaveStatusScope): ProjectSyncHandle {
  saveStatusScope?.dispose()
  return {
    flushAndWait: () => Promise.reject(STALE_PROJECT_LOAD_ERROR),
    retryConflictRecovery: () => Promise.reject(STALE_PROJECT_LOAD_ERROR),
    resumeInvalidSnapshot: () => {},
    dispose: async () => {},
  }
}

export interface ProjectSyncDeps {
  loadProject(projectId: string): ReturnType<typeof api.loadProject>
  saveProject(
    projectId: string,
    snapshot: CanvasDoc,
    revision: number,
    conflictKey: string,
  ): ReturnType<typeof api.saveProject>
  schedule?(callback: () => void, delayMs: number): unknown
  unschedule?(timer: unknown): void
  sleep?(delayMs: number): Promise<void>
  onHidden?(callback: () => void): () => void
  createConflictKey?(): string
  recoveryStorage?: ProjectRecoveryStorage
}

type SaveWaiter = {
  targetVersion: number
  resolve(value: { revision: number }): void
  reject(error: Error): void
}

async function migrateInlineMedia(snapshot: unknown): Promise<{ snapshot: unknown; changed: boolean }> {
  if (!snapshot || typeof snapshot !== 'object') return { snapshot, changed: false }
  const doc = snapshot as CanvasDoc
  if (!Array.isArray(doc.items)) return { snapshot, changed: false }
  let changed = false
  const items = doc.items.map((item) => ({ ...item }))
  const assets = Array.isArray(doc.assets) ? doc.assets.map((asset) => ({ ...asset })) : undefined
  // Архив тоже переносим: без этого его старый base64 было некому превратить в
  // файл, и sanitizeArchive выбрасывал запись при загрузке — заархивированная
  // картинка исчезала, хотя архив обещан как «снят с холста, но НЕ потерян».
  const archive = Array.isArray(doc.archive) ? doc.archive.map((entry) => ({ ...entry })) : undefined

  const isInline = (src?: string): boolean =>
    Boolean(src?.startsWith('data:image/') || src?.startsWith('data:video/'))

  for (const collection of [items, assets ?? [], archive ?? []]) {
    for (const entry of collection as Array<{ src?: string; mime?: string }>) {
      if (!isInline(entry.src)) continue
      const uploaded = await api.uploadAsset(entry.src!)
      entry.src = uploaded.url
      entry.mime = uploaded.mime
      changed = true
    }
  }

  return { snapshot: changed ? { ...doc, items, assets, archive } : snapshot, changed }
}

// Основной холст доски хранится на сервере в data/projects/<id>/project.json
// (только ссылки /media/…, без base64). Браузерное recovery-хранилище держит
// только последний несохранённый снимок до подтверждения сервером.
export async function initProjectSync(
  store: CanvasStore,
  projectId: string,
  onLoadState?: (state: ProjectLoadState) => void,
  onConflict?: (conflict: ProjectConflictSnapshot | null) => void,
  deps: ProjectSyncDeps = {
    loadProject: (id) => api.loadProject(id),
    saveProject: (id, snapshot, revision, conflictKey) => api.saveProject(id, snapshot, revision, conflictKey),
  },
  onLoadError?: (error: unknown) => void,
): Promise<ProjectSyncHandle> {
  const loadEpoch = nextProjectLoadEpoch(store)
  const saveStatusScope = createSaveStatusScope()
  const isCurrentAttempt = () => projectLoadEpochs.get(store) === loadEpoch
  const reportLoadState = (state: ProjectLoadState): void => {
    if (isCurrentAttempt()) onLoadState?.(state)
  }
  const reportConflict = (conflict: ProjectConflictSnapshot | null): void => {
    if (isCurrentAttempt()) onConflict?.(conflict)
  }
  const reportLoadError = (error: unknown): void => {
    if (isCurrentAttempt()) onLoadError?.(error)
  }
  const updateSaveStatus = (status: Parameters<SaveStatusScope['set']>[0]): void => {
    if (isCurrentAttempt()) saveStatusScope.set(status)
  }
  const scheduleTimer = deps.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs))
  const unscheduleTimer = deps.unschedule ?? ((timer) => window.clearTimeout(timer as number))
  const wait = deps.sleep ?? ((delayMs) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)))
  const recoveryStorage = deps.recoveryStorage ?? browserProjectRecoveryStorage
  const subscribeHidden = deps.onHidden ?? ((callback) => {
    const listener = () => {
      if (document.visibilityState === 'hidden') callback()
    }
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  })
  const conflictKey = deps.createConflictKey?.() ?? newId()
  reportLoadState('loading')
  let revision = 0
  let bootstrapConflict: ProjectConflictSnapshot | null = null
  let hadPendingRecovery = false
  try {
    const loaded = await deps.loadProject(projectId)
    if (!isCurrentAttempt()) return staleProjectSyncHandle(saveStatusScope)
    revision = loaded.revision
    const migrated = await migrateInlineMedia(loaded.snapshot)
    if (!isCurrentAttempt()) return staleProjectSyncHandle(saveStatusScope)
    if (migrated.changed) {
      const saved = await deps.saveProject(projectId, migrated.snapshot as CanvasDoc, revision, conflictKey)
      if (!isCurrentAttempt()) return staleProjectSyncHandle(saveStatusScope)
      revision = saved.revision
    }
    let snapshotToLoad = migrated.snapshot as CanvasDoc | null
    const loadedSnapshotError = localSnapshotMediaError(snapshotToLoad)
      ?? missingLocalMediaError(loaded.missingMedia ?? [])
    if (loadedSnapshotError) {
      // Старый экспорт мог сохранить view-ссылки сетевой доски или ссылку на
      // уже отсутствующий способ хранения. Не заменяем такой документ пустым и
      // не пытаемся записать его обратно: JSON остаётся доступен для явного
      // восстановления после возвращения исходных файлов.
      bootstrapConflict = createProjectConflictSnapshot(
        snapshotToLoad ?? { version: 1, items: [], camera: { x: 0, y: 0, scale: 1 } },
        revision,
        null,
        'needs-retry',
        'invalid-snapshot',
      )
      updateSaveStatus('error')
      console.warn("[CanAI] local snapshot contains inaccessible media:", loadedSnapshotError)
    }
    let pendingRecovery: ProjectRecoveryRecord | null = null
    try {
      pendingRecovery = recoveryStorage.load(projectId)
    } catch (recoveryError) {
      // The default adapter contains its own fallback, but an injected adapter
      // may fail. Keep the server document visible and mark the save state.
      updateSaveStatus('error')
      console.warn("[CanAI] failed to read deferred board:", recoveryError)
    }
    if (!isCurrentAttempt()) return staleProjectSyncHandle(saveStatusScope)
    // ⚠️ Отложенный снимок, совпадающий с серверным, восстанавливать НЕЧЕГО, а
    // отправка со старым номером ревизии рождает конфликтную копию на ровном
    // месте — и человек видит вторую доску, ничего для этого не сделав
    // (жалоба 18.09.2026, см. snapshotIdentity.ts).
    if (pendingRecovery && !recoveryWorthSending(pendingRecovery.snapshot, snapshotToLoad)) {
      const cleared = clearSavedRecovery(
        recoveryStorage,
        projectId,
        pendingRecovery.snapshot,
        { updatedAt: pendingRecovery.updatedAt, snapshot: pendingRecovery.snapshot },
      )
      if (!cleared.cleared) console.warn("[CanAI] failed to clear pending board:", cleared.error)
      pendingRecovery = null
    }
    hadPendingRecovery = pendingRecovery !== null
    const pendingRecoveryError = pendingRecovery
      ? localSnapshotMediaError(pendingRecovery.snapshot)
      : null
    if (pendingRecovery && !loadedSnapshotError && pendingRecoveryError) {
      // Recovery обязано оставаться durable, но отправлять заведомо
      // непереносимый снимок бессмысленно — сервер отвергнет его снова.
      bootstrapConflict = createProjectConflictSnapshot(
        pendingRecovery.snapshot,
        revision,
        null,
        'needs-retry',
        'invalid-snapshot',
      )
      updateSaveStatus('error')
      console.warn("[CanAI] deferred local snapshot contains inaccessible media:", pendingRecoveryError)
    } else if (pendingRecovery && !loadedSnapshotError) {
      try {
        // Use the revision from the failed attempt. If another device changed
        // the project meanwhile, the existing 409 path must reject this copy
        // instead of silently replacing the newer server document.
        // ⚠️ Досылаем под ключом ТОЙ вкладки, что писала снимок: если сервер
        // успел записать её последнюю правку и упал, не ответив, он узнает
        // свои же записи и не станет делать конфликтную копию.
        const saved = await deps.saveProject(
          projectId,
          pendingRecovery.snapshot,
          pendingRecovery.revision,
          pendingRecovery.conflictKey ?? conflictKey,
        )
        if (!isCurrentAttempt()) return staleProjectSyncHandle(saveStatusScope)
        revision = saved.revision
        snapshotToLoad = structuredClone(pendingRecovery.snapshot)
        const cleared = clearSavedRecovery(
          recoveryStorage,
          projectId,
          pendingRecovery.snapshot,
          { updatedAt: pendingRecovery.updatedAt, snapshot: pendingRecovery.snapshot },
        )
        if (!cleared.cleared) {
          updateSaveStatus('error')
          console.warn("[CanAI] failed to clear pending board:", cleared.error)
        } else if (cleared.durable) {
          updateSaveStatus('saved')
        }
      } catch (recoveryError) {
        if (!isCurrentAttempt()) return staleProjectSyncHandle(saveStatusScope)
        // Пока сервер не подтвердил отдельную копию, recovery остаётся.
        // После подтверждения повторная отправка создавала новую копию
        // при каждом входе, включая «Продолжить с последней версией».
        const parsed = parseProjectConflictError(recoveryError)
        bootstrapConflict = createProjectConflictSnapshot(
          pendingRecovery.snapshot,
          parsed?.serverRevision ?? revision,
          parsed?.recoveryProject ?? null,
          parsed?.recoveryProject ? 'saved' : 'needs-retry',
        )
        if (parsed?.recoveryProject) {
          try {
            const cleared = clearSavedRecovery(
              recoveryStorage,
              projectId,
              pendingRecovery.snapshot,
              { updatedAt: pendingRecovery.updatedAt, snapshot: pendingRecovery.snapshot },
            )
            updateSaveStatus(cleared.cleared ? 'saved' : 'error')
          } catch {
            updateSaveStatus('error')
          }
        } else {
          updateSaveStatus('error')
        }
        console.warn("[CanAI] failed to restore deferred board:", recoveryError)
      }
    }
    if (!isCurrentAttempt()) return staleProjectSyncHandle(saveStatusScope)
    // Пока загрузка не закончилась, CanvasSpace не монтирует интерактивный
    // холст, поэтому remote snapshot можно применить без гонки с вводом.
    store.loadDoc(snapshotToLoad)
    restoreProjectGenerationTasks(store, projectId)
  } catch (err) {
    if (!isCurrentAttempt()) return staleProjectSyncHandle(saveStatusScope)
    console.warn("[CanAI] failed to load board:", err)
    // доска НЕ загрузилась — автосейв не включаем: иначе первое же действие
    // пользователя записало бы почти пустой холст поверх настоящего project.json
    reportLoadState('error')
    reportLoadError(err)
    const loadError = err instanceof Error ? err : new Error("Failed to load board")
    saveStatusScope.dispose()
    return {
      flushAndWait: () => Promise.reject(loadError),
      retryConflictRecovery: () => Promise.reject(loadError),
      resumeInvalidSnapshot: () => {},
      dispose: async () => {},
    }
  }
  reportLoadState('ready')

  let timer: unknown
  let retryTimer: unknown
  let changeVersion = 0
  let savedVersion = 0
  let saving = false
  let disposed = false
  let conflict = bootstrapConflict !== null
  // после unmount ещё можно (и нужно) дописать последний снапшот
  let finalizing = false
  // снимок, снятый при dispose — store мог уже смениться/очиститься
  let frozenSnapshot: CanvasDoc | null = null
  const waiters = new Set<SaveWaiter>()
  let conflictError: Error | null = null
  let conflictSnapshot: ProjectConflictSnapshot | null = bootstrapConflict
  if (bootstrapConflict?.reason === 'invalid-snapshot') {
    conflictError = localSnapshotMediaError(bootstrapConflict.local)
      ?? new Error("The snapshot contains inaccessible media files")
  }
  let recoveryRecord: { updatedAt: number; snapshot: CanvasDoc } | null = null
  let recoveryStorageWarningShown = false
  if (bootstrapConflict) {
    reportConflict(bootstrapConflict)
    reportLoadState('conflict')
  }

  const persistRecoverySnapshot = (snapshot: CanvasDoc): void => {
    if (!isCurrentAttempt()) return
    try {
      // Keep a per-attempt marker so a confirmed conflict copy can remove the
      // exact recovery record this sync wrote, even when the latest snapshot
      // changed only in camera state while the request was in flight.
      const updatedAt = Math.max(Date.now(), (recoveryRecord?.updatedAt ?? 0) + 1)
      const persistedSnapshot = structuredClone(snapshot)
      const result = recoveryStorage.save({
        projectId,
        snapshot: persistedSnapshot,
        revision,
        updatedAt,
        conflictKey,
      })
      recoveryRecord = { updatedAt, snapshot: persistedSnapshot }
      if (!result.durable) {
        updateSaveStatus('error')
        if (!recoveryStorageWarningShown) {
          recoveryStorageWarningShown = true
          console.warn("[CanAI] the deferred board is stored only in memory:", result.error)
        }
      }
    } catch (error) {
      updateSaveStatus('error')
      if (!recoveryStorageWarningShown) {
        recoveryStorageWarningShown = true
        console.warn("[CanAI] failed to save pending board:", error)
      }
    }
  }

  const clearRecoverySnapshot = (confirmedSnapshot?: CanvasDoc): boolean => {
    if (!isCurrentAttempt()) return false
    try {
      const result = confirmedSnapshot || recoveryRecord !== null
        ? clearSavedRecovery(
          recoveryStorage,
          projectId,
          confirmedSnapshot,
          recoveryRecord ?? undefined,
        )
        : recoveryStorage.clear(projectId)
      if (!result.cleared) {
        updateSaveStatus('error')
        console.warn("[CanAI] failed to clear pending board:", result.error)
        return false
      }
      return true
    } catch (error) {
      updateSaveStatus('error')
      console.warn("[CanAI] failed to clear pending board:", error)
      return false
    }
  }

  // A server snapshot can itself contain stale local links (for example after
  // a manual media-folder move). Keep it in the same durable recovery slot as
  // an unsent edit before showing the conflict screen; the JSON button is then
  // backed by storage even if the tab is closed before the missing files are
  // restored.
  if (bootstrapConflict?.reason === 'invalid-snapshot' && !hadPendingRecovery) {
    persistRecoverySnapshot(bootstrapConflict.local)
  }

  const resolveWaiters = () => {
    for (const waiter of [...waiters]) {
      if (waiter.targetVersion > savedVersion) continue
      waiters.delete(waiter)
      waiter.resolve({ revision })
    }
  }

  const rejectWaiters = (error: Error) => {
    for (const waiter of waiters) waiter.reject(error)
    waiters.clear()
  }

  const save = async (): Promise<void> => {
    if (!isCurrentAttempt() || saving || conflict || savedVersion >= changeVersion) return
    saving = true
    try {
      while (isCurrentAttempt() && !conflict && savedVersion < changeVersion) {
        const targetVersion = changeVersion
        const snapshot = frozenSnapshot ?? store.toDoc()
        updateSaveStatus('saving')
        persistRecoverySnapshot(snapshot)
        const localSnapshotError = localSnapshotMediaError(snapshot)
        if (localSnapshotError) {
          // Не гоняем один и тот же заведомо отвергаемый документ по сети:
          // recovery уже сохранён, а после возвращения файлов или удаления
          // битого объекта следующая мутация снова сможет пройти.
          conflict = true
          conflictError = localSnapshotError
          conflictSnapshot = createProjectConflictSnapshot(
            snapshot,
            revision,
            null,
            'needs-retry',
            'invalid-snapshot',
          )
          updateSaveStatus('error')
          rejectWaiters(localSnapshotError)
          reportConflict(conflictSnapshot)
          reportLoadState('conflict')
          return
        }
        try {
          const result = await deps.saveProject(projectId, snapshot, revision, conflictKey)
          if (!isCurrentAttempt()) {
            rejectWaiters(STALE_PROJECT_LOAD_ERROR)
            return
          }
          revision = result.revision
          savedVersion = targetVersion
          resolveWaiters()
        } catch (err) {
          if (!isCurrentAttempt()) {
            // A load for the same store may have superseded this sync while
            // the request was in flight. Do not leave callers waiting on a
            // receipt that can no longer be fulfilled by the stale handle.
            rejectWaiters(STALE_PROJECT_LOAD_ERROR)
            return
          }
          console.warn("[CanAI] failed to save board:", err)
          updateSaveStatus('error')
          const permanentError = permanentLocalSnapshotError(err)
          if (permanentError) {
            // Сервер подтвердил, что в сохранении нет доступного файла. Это не
            // сетевой сбой и не конфликт вкладок: повтор без ремонта только
            // создаёт шум, поэтому оставляем durable recovery и показываем
            // честную причину рядом с кнопкой JSON.
            conflict = true
            conflictError = permanentError
            conflictSnapshot = createProjectConflictSnapshot(
              snapshot,
              revision,
              null,
              'needs-retry',
              'invalid-snapshot',
            )
            rejectWaiters(permanentError)
            reportConflict(conflictSnapshot)
            reportLoadState('conflict')
          } else if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 409) {
            // Не перетираем более свежую вкладку. Автоповтор здесь опасен:
            // сервер уже сохранил отдельную ветку, теперь подтверждаем самый
            // свежий снимок этой вкладки и только после этого разрешаем уход.
            conflict = true
            conflictError = err
            rejectWaiters(err)
            reportLoadState('conflict-saving')
            const latestSnapshot = frozenSnapshot ?? store.toDoc()
            const parsed = parseProjectConflictError(err)
            if (!parsed) {
              conflictError = new Error("The server did not report the conflicting copy")
              conflictSnapshot = createProjectConflictSnapshot(
                latestSnapshot,
                revision,
                null,
                'needs-retry',
              )
            } else if (changeVersion > targetVersion) {
              try {
                const saved = await deps.saveProject(
                  parsed.recoveryProject.id,
                  latestSnapshot,
                  parsed.recoveryProject.revision,
                  conflictKey,
                )
                if (!isCurrentAttempt()) return
                conflictSnapshot = createProjectConflictSnapshot(
                  latestSnapshot,
                  parsed.serverRevision,
                  { ...parsed.recoveryProject, revision: saved.revision },
                  'saved',
                )
                updateSaveStatus('saved')
              } catch (recoveryError) {
                console.warn("[CanAI] failed to complete conflict copy:", recoveryError)
                conflictError = recoveryError instanceof Error
                  ? recoveryError
                  : new Error("Failed to complete conflict copy")
                conflictSnapshot = createProjectConflictSnapshot(
                  latestSnapshot,
                  parsed.serverRevision,
                  parsed.recoveryProject,
                  'needs-retry',
                )
              }
            } else {
              conflictSnapshot = createProjectConflictSnapshot(
                latestSnapshot,
                parsed.serverRevision,
                parsed.recoveryProject,
                'saved',
              )
              updateSaveStatus('saved')
            }
            if (conflictSnapshot.status === 'saved' && !clearRecoverySnapshot(conflictSnapshot.local)) {
              updateSaveStatus('error')
            }
            reportConflict(conflictSnapshot)
            reportLoadState('conflict')
          } else if (!disposed && !finalizing) {
            if (retryTimer !== undefined) unscheduleTimer(retryTimer)
            retryTimer = scheduleTimer(() => {
              retryTimer = undefined
              void save()
            }, 2000)
          }
          return
        }
      }
      if (savedVersion >= changeVersion) {
        if (clearRecoverySnapshot()) updateSaveStatus('saved')
      }
    } finally {
      saving = false
      if (isCurrentAttempt() && !conflict && savedVersion < changeVersion && !retryTimer && !disposed && !finalizing) {
        void save()
      }
    }
  }
  const resumeInvalidSnapshot = (): void => {
    if (!isCurrentAttempt() || conflictSnapshot?.reason !== 'invalid-snapshot') return
    // Keep durable recovery and let the person repair/delete the stale item.
    // The next mutation is validated again before any network write.
    conflict = false
    conflictError = null
    conflictSnapshot = null
    reportConflict(null)
    reportLoadState('ready')
  }

  let pendingDelay = Infinity
  const schedule = (delay: number) => {
    if (!isCurrentAttempt() || disposed || finalizing) return
    if (conflict) {
      if (conflictSnapshot?.reason !== 'invalid-snapshot') return
      resumeInvalidSnapshot()
    }
    // Start durable recovery at the content mutation boundary. Camera writes
    // keep their slower debounce and are persisted before that save starts.
    if (delay <= SAVE_DEBOUNCE_MS) persistRecoverySnapshot(store.toDoc())
    changeVersion++
    // длинный (камерный) таймер не заменяет уже стоящий короткий (контентный):
    // сейв контента не должен откладываться из-за панорамы
    if (timer != null && pendingDelay <= delay) return
    if (timer !== undefined) unscheduleTimer(timer)
    pendingDelay = delay
    timer = scheduleTimer(() => {
      timer = undefined
      pendingDelay = Infinity
      void save()
    }, delay)
  }
  // несохранённое дописываем сразу, а не отменяем: раньше смена доски или
  // сворачивание вкладки молча теряли правки последних 800 мс
  const flush = () => {
    if (!isCurrentAttempt() || savedVersion >= changeVersion || conflict) return
    if (timer !== undefined) unscheduleTimer(timer)
    timer = undefined
    pendingDelay = Infinity
    void save()
  }

  // Дожидаемся записи: React cleanup не await'ит, но мы возвращаем Promise
  // dispose, а CanvasSpace зовёт void dispose() / ждёт при быстром cleanup.
  const flushFinal = async (): Promise<void> => {
    if (!isCurrentAttempt() || conflict || savedVersion >= changeVersion) return
    finalizing = true
    if (timer !== undefined) unscheduleTimer(timer)
    timer = undefined
    pendingDelay = Infinity
    if (retryTimer !== undefined) unscheduleTimer(retryTimer)
    retryTimer = undefined
    // фиксируем документ сейчас — после unmount store может уйти в другую доску
    if (savedVersion < changeVersion) {
      frozenSnapshot = store.toDoc()
    }
    for (let attempt = 0; attempt < FINAL_FLUSH_ATTEMPTS; attempt++) {
      if (!isCurrentAttempt() || conflict || savedVersion >= changeVersion) break
      // ждём текущий in-flight save, если он уже идёт
      if (saving) {
        await wait(FINAL_FLUSH_RETRY_MS)
        continue
      }
      await save()
      if (!isCurrentAttempt() || conflict || savedVersion >= changeVersion) break
      await wait(FINAL_FLUSH_RETRY_MS)
    }
  }

  const unsubscribeHidden = subscribeHidden(flush)

  const unsubContent = store.subscribeDocument(() => schedule(SAVE_DEBOUNCE_MS))
  const unsubCamera = store.subscribeCamera(() => schedule(CAMERA_DEBOUNCE_MS))

  const flushAndWait = (): Promise<{ revision: number }> => {
    if (!isCurrentAttempt()) return Promise.reject(STALE_PROJECT_LOAD_ERROR)
    if (conflict) return Promise.reject(conflictError ?? new Error("Board version conflict"))
    const targetVersion = changeVersion
    if (savedVersion >= targetVersion) return Promise.resolve({ revision })
    const receipt = new Promise<{ revision: number }>((resolve, reject) => {
      waiters.add({ targetVersion, resolve, reject })
    })
    flush()
    return receipt
  }

  const retryConflictRecovery = async (): Promise<ProjectConflictSnapshot> => {
    if (!isCurrentAttempt()) throw STALE_PROJECT_LOAD_ERROR
    if (conflictSnapshot?.reason === 'invalid-snapshot') {
      const candidate = frozenSnapshot ?? store.toDoc()
      const localError = localSnapshotMediaError(candidate)
      if (localError) {
        conflictError = localError
        updateSaveStatus('error')
        throw localError
      }
      reportLoadState('conflict-saving')
      updateSaveStatus('saving')
      try {
        const saved = await deps.saveProject(projectId, candidate, revision, conflictKey)
        if (!isCurrentAttempt()) throw STALE_PROJECT_LOAD_ERROR
        revision = saved.revision
        savedVersion = changeVersion
        conflict = false
        conflictError = null
        const repaired = createProjectConflictSnapshot(candidate, revision, null, 'saved', 'invalid-snapshot')
        conflictSnapshot = null
        const cleared = clearRecoverySnapshot(candidate)
        updateSaveStatus(cleared ? 'saved' : 'error')
        reportConflict(null)
        reportLoadState('ready')
        return repaired
      } catch (error) {
        if (!isCurrentAttempt()) throw STALE_PROJECT_LOAD_ERROR
        conflictError = error instanceof Error ? error : new Error("Failed to save the restored board")
        updateSaveStatus('error')
        reportLoadState('conflict')
        throw conflictError
      }
    }
    if (!conflictSnapshot?.recoveryProject) {
      throw new Error("The server did not report the conflicting copy")
    }
    reportLoadState('conflict-saving')
    updateSaveStatus('saving')
    try {
      const saved = await deps.saveProject(
        conflictSnapshot.recoveryProject.id,
        conflictSnapshot.local,
        conflictSnapshot.recoveryProject.revision,
        conflictKey,
      )
      if (!isCurrentAttempt()) throw STALE_PROJECT_LOAD_ERROR
      conflictSnapshot = createProjectConflictSnapshot(
        conflictSnapshot.local,
        conflictSnapshot.serverRevision,
        { ...conflictSnapshot.recoveryProject, revision: saved.revision },
        'saved',
      )
      conflictError = null
      updateSaveStatus(clearRecoverySnapshot(conflictSnapshot.local) ? 'saved' : 'error')
      reportConflict(conflictSnapshot)
      reportLoadState('conflict')
      return conflictSnapshot
    } catch (error) {
      if (!isCurrentAttempt()) throw STALE_PROJECT_LOAD_ERROR
      conflictError = error instanceof Error ? error : new Error("Failed to complete conflict copy")
      updateSaveStatus('error')
      reportLoadState('conflict')
      throw conflictError
    }
  }

  const dispose = async (): Promise<void> => {
    unsubContent()
    unsubCamera()
    unsubscribeHidden()
    disposed = true
    // Stop this handle from publishing a late status after a newer board has
    // taken over the global top-bar indicator. The final flush still runs.
    saveStatusScope.dispose()
    if (retryTimer !== undefined) unscheduleTimer(retryTimer)
    retryTimer = undefined
    if (!isCurrentAttempt()) {
      if (timer !== undefined) unscheduleTimer(timer)
      timer = undefined
      pendingDelay = Infinity
      rejectWaiters(STALE_PROJECT_LOAD_ERROR)
      return
    }
    await flushFinal()
    if (conflict) {
      if (conflictSnapshot?.status === 'saved') return
      throw conflictError ?? new Error("Board version conflict")
    }
    if (savedVersion < changeVersion) {
      const recoverySnapshot = frozenSnapshot ?? store.toDoc()
      persistRecoverySnapshot(recoverySnapshot)
      const error = new Error("Failed to save the board after several attempts")
      rejectWaiters(error)
      throw error
    }
    resolveWaiters()
  }

  return { flushAndWait, retryConflictRecovery, resumeInvalidSnapshot, dispose }
}
