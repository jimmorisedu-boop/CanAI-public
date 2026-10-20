import Konva from 'konva'
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Arc, Group, Image as KonvaImage, Rect, Text as KonvaText } from 'react-konva'
import type { CanvasStore } from './canvasStore'
import { requestPromptFill } from '../promptFillBus'
import {
  canRetryGeneration,
  cancelGeneration,
  generationConnectionLabel,
  getGenerationTasks,
  retryGeneration,
  subscribeGenerationTasks,
} from '../generationRegistry'
import { showErrorToast } from '../toastBus'
import { onCanvasItemDragMove, onCanvasItemDragStart, onDragEnd, onTransformEnd, onTransformPreview, selectOnClick, useThemeColors, type KEvent } from './itemHelpers'
import { CardActionButton } from './CardActionButton'
import { errorCardLayout } from './pendingCardLayout'
import { PENDING_LEASE_REFUSED, withBoardLease } from './boardLeaseActions'
import type { Placeholder } from './types'
import { requestMediaImportCancel } from '../mediaImportCancelBus'
import { retryFailedLinkEntries } from './mediaLinkController'
import { CANVAS_MONO_FONT, CANVAS_SANS_FONT } from './fonts'
import { canRetryCard, forgetCardRetry, retryCard } from './transientCardRetry'
import { isOrphanedLaunch, ORPHANED_LAUNCH } from '../pendingLaunchState'
import { useImageEl } from './media'
import { mediaCornerRadius } from './canvasLayout'
import { systemErrorMessage, systemStatusMessage } from '../../../ui/systemMessage'

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(0, Math.round(value / 1024))}KB`
  return `${Math.max(0, Math.round(value / (1024 * 1024)))}MB`
}

/** Нижняя строка идущей карточки: ход загрузки, стадия или секунды. */
export function pendingProgressLine(p: Placeholder, elapsed: number): string {
  if (p.taskType === 'media-import') {
    return p.percent !== undefined
      ? `${p.percent}%${p.totalBytes ? ` · ${formatBytes(p.downloadedBytes ?? 0)} / ${formatBytes(p.totalBytes)}` : ''}`
      : systemStatusMessage(p.stage, 'Preparing…')
  }
  // Своя работа едет на сервер команды — проценты, а не секунды (пункт 3.6).
  if (p.transient && p.percent !== undefined) return `Uploading ${p.percent}%`
  if (p.transient && p.stage) return systemStatusMessage(p.stage, 'Uploading…')
  return `${elapsed}s`
}

/** Скругление карточки-заглушки — одно на её тело и на кольцо выделения. */
const PENDING_CARD_RADIUS = 10

export const PendingItem = memo(function PendingItem({
  p,
  store,
  draggable,
  selected,
  viewScale = 1,
}: {
  p: Placeholder
  store: CanvasStore
  draggable: boolean
  selected: boolean
  viewScale?: number
}) {
  const groupRef = useRef<Konva.Group>(null)
  const arcRef = useRef<Konva.Arc>(null)
  const [elapsed, setElapsed] = useState(0)
  // «Стоп» нажат: показываем «Отменяю…» — сервер может и не успеть снять
  // оплаченную задачу, тогда вместо отмены честно приедет готовый результат
  const [cancelRequested, setCancelRequested] = useState(false)
  const tc = useThemeColors()
  // Статус связи живёт в реестре, а не в снапшоте доски: временный отказ
  // опроса не должен перекрашивать документ и переживает смену доски.
  const generationTasks = useSyncExternalStore(
    subscribeGenerationTasks,
    getGenerationTasks,
    getGenerationTasks,
  )
  const generationTask = p.jobId
    ? generationTasks.find((task) => task.jobId === p.jobId)
    : undefined
  const connectionLabel = generationConnectionLabel(generationTask?.connection)
  // 404 доставки может прийти раньше, чем обработчик sink успеет покрасить
  // заглушку. Не оставляем её крутиться вечно в этом коротком окне.
  const deliveryFailed = generationTask?.connection === 'delivery-error'
  // Брошенный запуск восстановление доски красит само, но только там, где
  // доску можно править: у зрителя правку не примут — показываем сбоем здесь.
  const orphaned = isOrphanedLaunch(p, Date.now())
  const loading = p.status === 'loading' && !deliveryFailed && !orphaned
  const failed = p.status === 'error' || deliveryFailed || orphaned
  const rawVisibleError = p.error ?? (orphaned
    ? ORPHANED_LAUNCH
    : deliveryFailed ? generationTask?.error ?? 'Task not found' : undefined)
  const visibleError = rawVisibleError ? systemErrorMessage(rawVisibleError) : undefined
  // снимок запроса живёт в реестре задач и пропадает после перезагрузки —
  // тогда повторять нечем, и кнопку не показываем
  const mediaImport = p.taskType === 'media-import'
  // Повтор карточки, живущей только в этой вкладке (перенос файла вставки).
  const cardRetry = canRetryCard(p.id)
  const retryable = !loading && (cardRetry || (mediaImport
    ? Boolean(p.sourceLinkId && p.importEntryId)
    : canRetryGeneration(p.jobId)))

  // счётчик секунд
  useEffect(() => {
    if (!loading) return
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - p.startedAt) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [loading, p.startedAt])

  // вращение спиннера — отдельная Konva-анимация слоя (как у видео)
  useEffect(() => {
    if (!loading || !arcRef.current) return
    const layer = arcRef.current.getLayer()
    if (!layer) return
    const anim = new Konva.Animation((frame) => {
      if (frame && arcRef.current) arcRef.current.rotation((frame.time * 0.36) % 360)
    }, layer)
    anim.start()
    return () => {
      anim.stop()
    }
  }, [loading])

  // Своя работа видна сразу, пока едет (обрезка, правка из редактора).
  const preview = useImageEl(loading ? p.previewSrc : undefined)
  // Номер `local:` снять нельзя: такая работа живёт в этой вкладке, а не у
  // сервера, и «Стоп» на ней ничего бы не сделал.
  const stoppable = Boolean(p.jobId && !p.jobId.startsWith('local:'))
  // Задача уже закончилась, а карточка осталась крутиться: останавливать
  // нечего, и «Стоп» вёл бы в вечное «Отменяю…». Карточку можно только убрать.
  const taskFinished = generationTask?.state === 'done' || generationTask?.state === 'error'
    || generationTask?.state === 'cancelled'

  const cx = p.w / 2
  const cy = p.h / 2
  // читаемость на любых пропорциях: подпись масштабируется от размера самой
  // карточки (короче сторона — она задаёт масштаб)
  const scale = Math.min(1.3, Math.max(0.7, Math.min(p.w, p.h) / 300))
  // Работа с картинкой рисуется кадром медиа — тем же скруглением, что у
  // готового объекта, который встанет на её место (canvasLayout).
  const mediaRadius = mediaCornerRadius(viewScale, p.w, p.h)
  const error = errorCardLayout({ w: p.w, h: p.h, scale })
  const progressLine = cancelRequested ? 'Canceling…' : connectionLabel ?? pendingProgressLine(p, elapsed)

  return (
    <Group
      id={p.id}
      // Размер и скругление — для кольца выделения (SelectionRings).
      selectionFrame={{ w: p.w, h: p.h, radius: loading && preview ? mediaRadius : PENDING_CARD_RADIUS }}
      ref={groupRef}
      x={p.x}
      y={p.y}
      rotation={p.rotation ?? 0}
      draggable={draggable}
      onDragStart={(e) => onCanvasItemDragStart(store, p.id, e)}
      onDragMove={(e) => onCanvasItemDragMove(store, p.id, e)}
      onDragEnd={(e) => onDragEnd(store, p.id, e)}
      onTransform={() => groupRef.current && onTransformPreview(store, p.id, groupRef.current)}
      onTransformEnd={() => groupRef.current && onTransformEnd(store, p.id, groupRef.current)}
      onClick={(e) => selectOnClick(store, p.id, e)}
      onTap={(e) => selectOnClick(store, p.id, e as unknown as KEvent)}
      onDblClick={(e: KEvent) => {
        e.cancelBubble = true
        if (!p.prompt) return
        requestPromptFill({ shapeId: p.id, prompt: p.prompt, modelId: p.modelId, referenceIds: p.referenceIds })
        const validRefs = (p.referenceIds || []).filter((id) => Boolean(store.getItem(id)))
        store.setSelection(validRefs)
      }}
    >
      {loading && preview ? (
        <>
          {/* Сама работа — сразу; пунктир и строка внизу говорят, что она ещё
              едет на сервер и у коллег пока не видна. */}
          {/* Мышь ловит сама картинка, как у обычной заглушки — вся площадь.
              Раньше ловила только пунктирная рамка толщиной в полтора
              пикселя, и карточку было почти не взять. */}
          <KonvaImage
            image={preview}
            width={p.w}
            height={p.h}
            crop={p.previewCrop}
            cornerRadius={mediaRadius}
            perfectDrawEnabled={false}
          />
          <Rect
            width={p.w}
            height={p.h}
            stroke={tc.pendingStroke}
            strokeWidth={1.5}
            strokeScaleEnabled={false}
            dash={[9, 9]}
            cornerRadius={mediaRadius}
            perfectDrawEnabled={false}
            listening={false}
          />
          <Rect
            x={8 * scale}
            y={p.h - 30 * scale}
            width={Math.max(0, p.w - 16 * scale)}
            height={22 * scale}
            fill={tc.pendingFill}
            opacity={0.92}
            cornerRadius={11 * scale}
            listening={false}
          />
          <KonvaText
            x={8 * scale}
            y={p.h - 30 * scale}
            width={Math.max(0, p.w - 16 * scale)}
            height={22 * scale}
            text={progressLine}
            fontSize={12 * scale}
            fill={tc.timerColor}
            align="center"
            verticalAlign="middle"
            fontFamily={CANVAS_MONO_FONT}
            ellipsis
            listening={false}
          />
        </>
      ) : (
        <Rect
          width={p.w}
          height={p.h}
          fill={loading ? tc.pendingFill : tc.errorFill}
          stroke={loading ? tc.pendingStroke : tc.errorStroke}
          strokeWidth={1.5}
          // Рамка — линия на экране, а не полоса доски: при приближении она
          // не толстеет, при отдалении не исчезает (жалоба 30.09.2026).
          strokeScaleEnabled={false}
          dash={loading ? [9, 9] : undefined}
          cornerRadius={PENDING_CARD_RADIUS}
          perfectDrawEnabled={false}
        />
      )}
      {loading && preview ? null : loading ? (
        <>
          <Arc
            ref={arcRef}
            x={cx}
            y={cy - 12 * scale}
            innerRadius={13 * scale}
            outerRadius={16 * scale}
            angle={280}
            fill={tc.spinnerColor}
            perfectDrawEnabled={false}
            listening={false}
          />
          <KonvaText
            y={cy + 14 * scale}
            width={p.w}
            text={p.label}
            fontSize={14 * scale}
            fill={tc.labelColor}
            align="center"
            fontFamily={CANVAS_SANS_FONT}
            ellipsis
            listening={false}
          />
          <KonvaText
            y={cy + 36 * scale}
            width={p.w}
            text={progressLine}
            fontSize={12 * scale}
            fill={tc.timerColor}
            align="center"
            fontFamily={CANVAS_MONO_FONT}
            listening={false}
          />
          {stoppable && !cancelRequested && (
            <CardActionButton
              x={cx - 34 * scale}
              y={cy + 56 * scale}
              width={68 * scale}
              height={26 * scale}
              fontSize={11 * scale}
              label={taskFinished ? 'Remove' : 'Stop'}
              textColor={tc.errorText}
              accent={tc.accent}
              accentHover={tc.accentHover}
              onPress={() => {
                if (taskFinished && !mediaImport) {
                  void withBoardLease(store, p.id, () => store.dismissPendingById(p.id))
                    .then((admitted) => { if (!admitted) showErrorToast(PENDING_LEASE_REFUSED) })
                  return
                }
                setCancelRequested(true)
                if (mediaImport) requestMediaImportCancel(p.jobId!)
                else void cancelGeneration(p.jobId!).catch(() => setCancelRequested(false))
              }}
            />
          )}
        </>
      ) : (
        <>
          {/* Раскладка считается от КРАЁВ карточки, а не отступами от центра:
              длинный текст ошибки (а он бывает в четыре строки) наезжал на
              кнопки. Теперь кнопки прибиты к низу, текст занимает всё, что
              осталось сверху, и обрезается многоточием, если не влез. */}
          {error.showTitle && (
            <KonvaText
              x={error.pad}
              y={error.titleY}
              width={p.w - error.pad * 2}
              text="Failed"
              fontSize={error.titleSize}
              fontStyle="600"
              fill={tc.errorText}
              align="center"
              fontFamily={CANVAS_SANS_FONT}
              listening={false}
            />
          )}
          {error.detailH > 0 && (
            <KonvaText
              x={error.pad}
              y={error.detailY}
              width={p.w - error.pad * 2}
              height={error.detailH}
              text={visibleError ?? 'error'}
              fontSize={error.detailSize}
              lineHeight={1.45}
              fill={tc.labelColor}
              align="center"
              verticalAlign="middle"
              fontFamily={CANVAS_SANS_FONT}
              wrap="word"
              ellipsis
              listening={false}
            />
          )}
          {/* Раньше на красной карточке не было НИЧЕГО: промпт, модель и
              референсы приходилось набирать заново, хотя снимок запроса лежит
              в реестре задач. «Убрать» тоже был неочевиден — только Delete. */}
          {retryable && (
            <CardActionButton
              x={cx - error.btnW - error.gap / 2}
              y={error.buttonsY}
              width={error.btnW}
              height={error.btnH}
              fontSize={11 * scale}
              label="Retry"
              textColor={tc.errorText}
              accent={tc.accent}
              accentHover={tc.accentHover}
              onPress={() => {
                if (cardRetry) {
                  retryCard(p.id)
                } else if (mediaImport && p.sourceLinkId && p.importEntryId) {
                  retryFailedLinkEntries(p.sourceLinkId, [p.importEntryId])
                } else {
                  // Повтор тоже правит карточку: без аренды он молчал так же,
                  // как «Убрать».
                  void withBoardLease(store, p.id, async () => {
                    const nextJobId = await retryGeneration(p.jobId!)
                    store.restartPending(p.id, nextJobId)
                  })
                    .then((admitted) => { if (!admitted) showErrorToast(PENDING_LEASE_REFUSED) })
                    .catch((error) =>
                      showErrorToast(error instanceof Error ? error.message : 'Failed to retry'),
                    )
                }
              }}
            />
          )}
          <CardActionButton
            x={retryable ? cx + error.gap / 2 : cx - error.btnW / 2}
            y={error.buttonsY}
            width={error.btnW}
            height={error.btnH}
            fontSize={11 * scale}
            label="Remove"
            textColor={tc.errorText}
            accent={tc.accent}
            accentHover={tc.accentHover}
            onPress={() => {
              forgetCardRetry(p.id)
              void withBoardLease(store, p.id, () => store.dismissPendingById(p.id))
                .then((admitted) => { if (!admitted) showErrorToast(PENDING_LEASE_REFUSED) })
            }}
          />
        </>
      )}
    </Group>
  )
})
