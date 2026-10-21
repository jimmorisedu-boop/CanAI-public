import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../../api'
import { IconClose, IconNext, IconPrev } from '../../../ui/icons'
import { isActiveModal, useModalFocus } from '../../../tablet/modalFocus'
import type { CatalogModel } from '../../../types'
import type { CanvasStore } from '../konva/canvasStore'
import { isMarkDigit, markStep, MARK_COMMIT_MS } from '../konva/markInput'
import type { CanvasItem } from '../konva/types'
import { useContentVersion } from '../konva/useStore'
import { notify } from '../notifications'
import { closeCompare, type CompareViewing } from './compareBus'
import { panelLabel, panelSubLabel } from './compareLabels'
import { compareLayout, visibleSlice, wrapCursor, type CompareKind, type CompareLayout } from './compareLayout'
import { DEFAULT_FACE_THRESHOLD } from './faceMath'
import { FaceSimilarityChip, useFaceSimilarity } from './FaceSimilarityChip'
import { FacePickOverlay } from './FacePickOverlay'
import { detectFaces } from './faceSimilarity'
import type { DetectedFace } from './faceMath'
import { resetFaceSessions } from './faceSimilarity'
import { CompareOverlayView, type OverlayMode } from './CompareOverlayView'
import { ComparePanelsView } from './ComparePanelsView'
import { useT } from '../../../i18n/context.js'


// Просмотрщик сравнения — обычный HTML-оверлей поверх холста (не Konva:
// штора это одна строка CSS, разница — mix-blend-mode, видео играет само).
// Раскладку выбирает не пользователь, а типы: картинки — наложением,
// видео — рядом (см. compareLayout).

/** Порог сходства лиц живёт в настройках приложения: он про калибровку под
 *  свой материал, а не про конкретное сравнение, и обязан переживать выход. */
function useFaceThreshold(): [number, (value: number) => void] {
  const [threshold, setThreshold] = useState(DEFAULT_FACE_THRESHOLD)
  useEffect(() => {
    let active = true
    api.getSettings()
      .then((settings) => {
        if (active && typeof settings.faceThreshold === 'number') setThreshold(settings.faceThreshold)
      })
      .catch(() => {
        /* не дозвонились — работаем со значением по умолчанию */
      })
    return () => {
      active = false
    }
  }, [])
  const save = (value: number) => {
    setThreshold(value)
    // Сохраняем молча: это ручка настройки, а не действие с последствиями.
    api.getSettings()
      .then((settings) => api.saveSettings(
        settings.externalEditorPath,
        undefined,
        settings.optimiseLargeImages,
        settings.confirmCostAboveUsd,
        settings.assistantModelId,
        undefined,
        settings.shareLanAccess,
        value,
      ))
      .catch(() => {
        /* порог не сохранился — на текущем сравнении это не сказывается */
      })
  }
  return [threshold, save]
}

function useCatalog(): CatalogModel[] {
  const [models, setModels] = useState<CatalogModel[]>([])
  useEffect(() => {
    let active = true
    api.models()
      .then((res) => {
        if (active) setModels(res.models)
      })
      .catch(() => {
        /* без каталога покажем id модели — не критично */
      })
    return () => {
      active = false
    }
  }, [])
  return models
}

// Натуральный размер картинки: рамки детектора заданы в пикселях исходника,
// а на экране кадр вписан в произвольный бокс.
function naturalSizeOf(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('frame could not be read'))
    image.src = src
  })
}

export function CompareViewer({
  store,
  session,
}: {
  store: CanvasStore
  session: CompareViewing
}) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocus(dialogRef, closeCompare)
  const models = useCatalog()
  const [threshold, setThreshold] = useFaceThreshold()
  // Пересчёт после докачки моделей: до неё сравнивать было нечем.
  const [faceAttempt, setFaceAttempt] = useState(0)
  // подписка на стор: без неё поставленная метка не перерисовывала плашку —
  // цифру набрали, а на экране ничего не менялось
  useContentVersion(store)
  const [cursor, setCursor] = useState(0)
  // по умолчанию «Переключение» — самый быстрый способ увидеть разницу
  const [mode, setMode] = useState<OverlayMode>('toggle')
  // Режим «Переключение». По умолчанию на экране КАНДИДАТ (результат), а
  // пробел работает на УДЕРЖАНИЕ: зажал — показался исходник, отпустил —
  // вернулся результат. Так сделано в боевом просмотрщике пользователя, и
  // глаз ловит смещение лучше, чем при обычном тумблере.
  const [showBaseline, setShowBaseline] = useState(false)
  const [peek, setPeek] = useState(false)
  // Подсказка клавиш нужна при входе в просмотрщик, но не должна постоянно
  // лежать поверх кадра. После короткого покоя она только бледнеет — геометрия
  // не двигается, поэтому общая ось glass-панелей остаётся стабильной.
  const [controlsResting, setControlsResting] = useState(false)
  // буфер набора метки цифрами (см. pushMarkDigit)
  const markBufferRef = useRef('')
  const markTargetRef = useRef<string | null>(null)
  const markTimerRef = useRef<number | null>(null)

  // Исходник мог уехать в архив (его подтянули по родословной) — ищем в обоих
  // местах.
  const baseline = store.getItem(session.baselineId) ?? store.getArchivedItem(session.baselineId)
  // ⚠️ А КАНДИДАТА ищем ТОЛЬКО на холсте. Delete отправляет проигравшего в
  // архив, и пока он находился ещё и там, список кандидатов не укорачивался:
  // просмотрщик продолжал показывать только что убранный кадр, а следующий
  // Delete уже не менял ничего (archiveItems возвращает 0) — человек оставался
  // с проигравшим один на один, хотя тост честно сказал «Отправлено в архив»
  // (найдено прогоном 17.09.2026). Кандидатов набирают кликами по холсту,
  // архивных среди них не бывает.
  const candidates = session.candidateIds
    .map((id) => store.getItem(id))
    .filter((item): item is CanvasItem => Boolean(item))

  // Сравниваем ПАРАМИ, поэтому раскладку решает текущая пара, а не весь набор:
  // иначе одно видео среди картинок разводило бы по панелям и те пары, где
  // видео нет вовсе — и пробел там не значил бы ничего.
  const shownCandidate = candidates[wrapCursor(cursor, candidates.length)]
  const kinds: CompareKind[] = useMemo(
    () =>
      [baseline, shownCandidate]
        .filter((item): item is CanvasItem => Boolean(item))
        .map((item) => (item.kind === 'video' ? 'video' : 'image')),
    [baseline, shownCandidate],
  )
  /**
   * Раскладка. Пока не трогали — умолчание по типу материала (у видео «рядом»:
   * движение читается лучше), дальше выбор за человеком.
   *
   * ⚠️ У ВИДЕО способов ровно ДВА — «Рядом» и «Штора» (решение пользователя
   * 03.09.2026). «Переключение» и «Разница» ему не показываются: первое
   * подменяет кадр по удержанию пробела, а пробел у видео принадлежит
   * воспроизведению; второе смешивает пиксели двух кадров, которые к тому же
   * идут не синхронно, и показывает шум вместо разницы работы. У картинок все
   * три способа остаются — там наложение и есть главный приём.
   */
  const [layoutOverride, setLayoutOverride] = useState<CompareLayout | null>(null)
  const hasVideo = kinds.includes('video')
  // ⚠️ У ФОТО раскладка одна — наложение (решение пользователя 11.09.2026:
  // «при сравнении фото рядом не нужно»). Выбор, сделанный на видео, при
  // переходе стрелкой к картинке не переносится.
  const layout: CompareLayout = hasVideo ? layoutOverride ?? compareLayout(kinds) : 'overlay'
  // Штора — единственный осмысленный способ наложения для видео, поэтому в
  // нём режим не выбирают, а он просто такой.
  const overlayMode: OverlayMode = hasVideo ? 'wipe' : mode
  useEffect(() => { setLayoutOverride(null) }, [session.baselineId, session.candidateIds.join(',')])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Tab/Esc и вложенный выбор лица принадлежат общему стеку диалогов.
      if (!dialogRef.current || !isActiveModal(dialogRef.current)) return
      if (event.defaultPrevented || event.isComposing) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setCursor((prev) => wrapCursor(prev - 1, candidates.length))
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setCursor((prev) => wrapCursor(prev + 1, candidates.length))
        return
      }
      // Пробел принадлежит РЕЖИМУ, а не просмотрщику вообще: в «Переключении»
      // он показывает другой кадр НА УДЕРЖАНИЕ, в панелях с видео — играет и
      // ставит на паузу (это делает плеер), в «Шторе» и «Разнице» молчит.
      // Но кнопке он не принадлежит никогда: раньше это лечили blur() после
      // каждого клика, и клавиатурный пользователь терял место в интерфейсе
      // после любого нажатия. Гасим только активацию кнопки — Enter её жмёт.
      if (event.code === 'Space') {
        const onButton =
          event.target instanceof HTMLElement && event.target.closest('.compare-overlay button')
        if (onButton) event.preventDefault()
        if (layout !== 'overlay' || overlayMode !== 'toggle') return
        event.preventDefault()
        setPeek(true)
        return
      }
      if (isMarkDigit(event.key)) {
        event.preventDefault()
        pushMarkDigit(event.key)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        // ⚠️ Гасим событие НАСОВСЕМ, а не только действие по умолчанию.
        // archiveCurrent закрывает сравнение, когда кандидат был последним, и
        // дальше по цепочке хоткеи холста видят уже пустой getCompareSession():
        // тот же Delete срабатывал у них как removeSelected и удалял с холста
        // ИСХОДНИК — молча, мимо архива (найдено прогоном 17.09.2026).
        event.stopImmediatePropagation()
        archiveCurrent()
      }
    }
    // отпустили пробел — подглядка гаснет; blur страхует от «залипания»,
    // если окно потеряло фокус с зажатой клавишей
    function onKeyUp(event: KeyboardEvent): void {
      if (event.code === 'Space') setPeek(false)
    }
    const dropPeek = () => setPeek(false)

    // CAPTURE: холст и VideoItem слушают те же клавиши и глушат их
    // stopImmediatePropagation — пока сравнение открыто, клавиатура наша
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', dropPeek)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', dropPeek)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.length, layout, cursor, mode])

  useEffect(() => {
    let timer: number | null = null
    const wakeControls = () => {
      setControlsResting(false)
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => setControlsResting(true), 2800)
    }
    wakeControls()
    window.addEventListener('pointermove', wakeControls, { passive: true })
    window.addEventListener('keydown', wakeControls, true)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('pointermove', wakeControls)
      window.removeEventListener('keydown', wakeControls, true)
    }
  }, [])

  const current = candidates[wrapCursor(cursor, candidates.length)]

  // Сходство лиц считаем только для видимой пары картинок. Нет лиц — плашки
  // просто не будет: сравнение остаётся обычным сравнением любого материала.
  // Какое лицо мерить, когда их в кадре несколько. Ноль — самое крупное:
  // выбор нужен редко, поэтому по умолчанию его нет вовсе.
  const [faceIndexA, setFaceIndexA] = useState(0)
  const [faceIndexB, setFaceIndexB] = useState(0)
  const [picking, setPicking] = useState<null | {
    side: 'a' | 'b'
    src: string
    faces: DetectedFace[]
    natural: { width: number; height: number }
  }>(null)
  const faceState = useFaceSimilarity(baseline, current, faceAttempt, faceIndexA, faceIndexB)

  // Сменилась пара — выбор сбрасывается: номер лица на прошлой картинке про
  // эту ничего не значит.
  useEffect(() => {
    setFaceIndexA(0)
    setFaceIndexB(0)
    setPicking(null)
  }, [baseline?.id, current?.id])

  async function startFacePick(side: 'a' | 'b'): Promise<void> {
    const item = side === 'a' ? baseline : current
    if (!item?.src) return
    try {
      const [faces, natural] = await Promise.all([
        detectFaces(item.src),
        naturalSizeOf(item.src),
      ])
      if (faces.length === 0) return
      setPicking({ side, src: item.src, faces, natural })
    } catch {
      notify({ kind: 'error', message: t('Failed to show faces in the frame') })
    }
  }

  // Загрузка моделей — осознанное действие человека: 38 МБ не качаются сами.
  // Пока идёт, плашка честно говорит «считаю»: кнопки «включить» уже нет, а
  // делать вид, что ничего не происходит, нельзя.
  const [preparing, setPreparing] = useState(false)
  async function enableFaceModels(): Promise<void> {
    if (preparing) return
    setPreparing(true)
    try {
      let state = await api.prepareFaceModels()
      while (state.state === 'downloading') {
        await new Promise((resolve) => setTimeout(resolve, 700))
        state = await api.faceModelsState()
      }
      if (state.state !== 'ready') throw new Error(state.message || t('Models did not download'))
      resetFaceSessions()
      setFaceAttempt((value) => value + 1)
    } catch (error) {
      notify({
        kind: 'error',
        message: error instanceof Error ? error.message : t('Failed to enable face comparison'),
      })
    } finally {
      setPreparing(false)
    }
  }

  // Метка набирается так же, как на холсте: «1» затем быстро «2» → «12».
  // Раньше здесь стояла своя однозначная проверка, и двух- и трёхзначные
  // номера в просмотрщике набрать было нельзя.
  function pushMarkDigit(digit: string): void {
    if (!current) return
    const targetId = markBufferRef.current ? markTargetRef.current : current.id
    if (!targetId) return
    const step = markStep(markBufferRef.current, digit)
    markBufferRef.current = step.buffer
    markTargetRef.current = targetId
    store.setMarks([targetId], step.mark, step.isFirstDigit)

    if (markTimerRef.current !== null) window.clearTimeout(markTimerRef.current)
    if (step.commit) {
      markBufferRef.current = ''
      markTimerRef.current = null
    } else {
      markTimerRef.current = window.setTimeout(() => {
        markBufferRef.current = ''
        markTimerRef.current = null
      }, MARK_COMMIT_MS)
    }
    // тоста нет намеренно: метка видна постоянно — плашкой у строки
    // «Кандидат» и на миниатюре, а тост исчезал и закрывал собой кадр
  }

  function archiveCurrent(): void {
    if (!current) return
    const moved = store.archiveItems([current.id])
    if (moved === 0) return
    notify({
      kind: 'info',
      message: t('Sent to Archive'),
      action: { label: t('Cancel'), run: () => store.undo() },
    })
    if (candidates.length <= 1) closeCompare()
    else setCursor((prev) => wrapCursor(prev, candidates.length - 1))
  }

  if (!baseline || candidates.length === 0) {
    return (
      <div ref={dialogRef} tabIndex={-1} className="compare-overlay" role="dialog" aria-modal="true" aria-label={t('Comparison')}>
        <div className="compare-empty">
          {t('Comparison objects are no longer available.')}
          <button className="chip-btn" onClick={closeCompare}>{t('Close')}</button>
        </div>
      </div>
    )
  }

  const shown = visibleSlice(baseline, candidates, cursor, layout)
  const labels = shown.map((item, index) => panelLabel(item, models, index === 0))
  // имена для блока ролей в шапке: у исходника это файл, у кандидата — модель
  const baselineName = panelSubLabel(baseline, true) || panelLabel(baseline, models, true)
  const candidateName = panelLabel(current, models, false)
  const shownIsBaseline = peek ? !showBaseline : showBaseline

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={`compare-overlay ${layout === 'side-by-side' ? 'is-panels' : ''} ${kinds.includes('video') ? 'has-player' : ''} ${controlsResting ? 'is-resting' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('Comparison')}
    >
      <header className="compare-head">
        {/* Кто есть кто — одним блоком, строка под строкой: роль слева, имя
            справа. В «Переключении» подсвечена та строка, что сейчас на
            экране, поэтому при подглядке видно, на что именно смотришь. */}
        <div className="compare-head-main">
          <div className={`compare-role-row ${layout === 'overlay' && overlayMode === 'toggle' && shownIsBaseline ? 'on' : ''}`}>
            <span className="compare-role">{t('Source')}</span>
            <span className="compare-role-name" title={baselineName}>{baselineName}</span>
            {session.pulledIn && <span className="compare-role-note">{t('by lineage')}</span>}
          </div>
          <div className={`compare-role-row ${layout === 'overlay' && overlayMode === 'toggle' && !shownIsBaseline ? 'on' : ''}`}>
            <span className="compare-role">{t('Candidate')}</span>
            <span className="compare-role-name" title={candidateName}>{candidateName}</span>
            {candidates.length > 1 && (
              <span className="compare-role-note">
                {wrapCursor(cursor, candidates.length) + 1} of {candidates.length}
              </span>
            )}
            {/* метка видна сразу и не исчезает — цифра ставится вслепую,
                и без этого непонятно, сработало ли вообще */}
            {current.mark != null && (
              <span className="compare-mark" title={t('Group-export label')}>
                {current.mark}
              </span>
            )}
          </div>
          {/* Сходство — ТРЕТЬЯ СТРОКА того же блока, а не отдельная плашка:
              рядом с «Исходник» и «Кандидат» она обязана читаться как их
              продолжение — та же колонка подписи, тот же кегль. Своей рамки и
              фона у неё нет, тон несёт точка. */}
          {faceState.kind !== 'off' && (
            <div className="compare-role-row">
              <span className="compare-role">{t('Similarity')}</span>
              <FaceSimilarityChip
                state={preparing ? { kind: 'busy' } : faceState}
                threshold={threshold}
                onThreshold={setThreshold}
                onEnable={() => void enableFaceModels()}
                onPick={(side) => void startFacePick(side)}
              />
            </div>
          )}
        </div>

        {picking && (
          <FacePickOverlay
            src={picking.src}
            faces={picking.faces}
            natural={picking.natural}
            selected={picking.side === 'a' ? faceIndexA : faceIndexB}
            title={picking.side === 'a' ? t('Source') : t('Candidate')}
            onPick={(index) => {
              if (picking.side === 'a') setFaceIndexA(index)
              else setFaceIndexB(index)
              setPicking(null)
            }}
            onCancel={() => setPicking(null)}
          />
        )}

        {/* Раскладка есть только у видео: «Рядом» или «Штора» (у видео
            наложение и есть штора). У фото её нет вовсе — только наложение
            (решение пользователя 11.09.2026). */}
        {hasVideo && (
          <div className="compare-modes" role="group" aria-label={t('Layout')}>
            {([
              ['side-by-side', 'Side by side'],
              ['overlay', 'Curtain'],
            ] as const).map(([value, title]) => (
              <button
                key={value}
                aria-pressed={layout === value}
                className={layout === value ? 'on' : ''}
                onClick={() => setLayoutOverride(value)}
              >
                {title}
              </button>
            ))}
          </div>
        )}

        {/* режимы меняют, КАК показан один и тот же кадр, — отдельной панели
            под каждым из них нет, поэтому переключатели, а не вкладки */}
        {layout === 'overlay' && !hasVideo && (
          <div className="compare-modes" role="group" aria-label={t('How to view')}>
            {([
              ['wipe', 'Curtain'],
              ['toggle', 'Switching'],
              ['diff', 'Difference'],
            ] as const).map(([value, title]) => (
              <button
                key={value}
                aria-pressed={mode === value}
                className={mode === value ? 'on' : ''}
                onClick={() => setMode(value)}
              >
                {title}
              </button>
            ))}
          </div>
        )}

        {/* Выход подписан, а не спрятан в подсказке: из полноэкранного режима
            над холстом надо видеть, как выйти, — так же, как из таймлайна. */}
        <button type="button" className="compare-close" aria-label={t('Close comparison (Esc)')} onClick={closeCompare}>
          <IconClose size={14} />{t('Esc — exit')}
        </button>
      </header>

      <div className="compare-body">
        {layout === 'overlay' ? (
          <CompareOverlayView
            baseline={baseline}
            candidate={current}
            mode={overlayMode}
            // подглядка на удержании пробела показывает противоположный кадр
            showBaseline={peek ? !showBaseline : showBaseline}
          />
        ) : (
          <ComparePanelsView items={shown} labels={labels} />
        )}
      </div>

      {candidates.length > 1 && (
        <div className="compare-strip">
          <button className="icon-btn" aria-label={t('Previous')} onClick={() => setCursor((p) => wrapCursor(p - 1, candidates.length))}>
            <IconPrev size={16} />
          </button>
          {candidates.map((item, index) => (
            <button
              key={item.id}
              className={`compare-thumb ${index === wrapCursor(cursor, candidates.length) ? 'on' : ''}`}
              title={panelLabel(item, models, false)}
              onClick={() => setCursor(index)}
            >
              {item.kind === 'video' ? <video src={item.src} muted preload="metadata" /> : <img src={item.src} alt="" />}
              {item.mark != null && <span className="compare-thumb-mark">{item.mark}</span>}
            </button>
          ))}
          <button className="icon-btn" aria-label={t('Next')} onClick={() => setCursor((p) => wrapCursor(p + 1, candidates.length))}>
            <IconNext size={16} />
          </button>
        </div>
      )}

      {/* Коротко: своё для режима плюс общий хвост. Полный список — в справке
          по горячим клавишам, здесь незачем перечислять всё. */}
      <footer className="compare-hint">
        <span className="compare-hint-item">
          {layout !== 'overlay' || hasVideo ? (
            <><kbd>Space</kbd><span>{t('play')}</span></>
          ) : overlayMode === 'toggle' ? (
            <><kbd>Space</kbd><span>{t('source')}</span></>
          ) : overlayMode === 'diff' ? (
            <span>{t('black — match')}</span>
          ) : (
            <span>{t('move the mouse')}</span>
          )}
        </span>
        {hasVideo && (
          <>
            <i className="compare-hint-separator" aria-hidden="true" />
            <span className="compare-hint-item"><kbd>{t('A D')}</kbd><span>{t('frame')}</span><kbd>{t('Shift')}</kbd><span>×10</span></span>
          </>
        )}
        <i className="compare-hint-separator" aria-hidden="true" />
            <span className="compare-hint-item"><kbd>{t('Double-click')}</kbd><span>100%</span></span>
        {candidates.length > 1 && (
          <>
            <i className="compare-hint-separator" aria-hidden="true" />
            <span className="compare-hint-item"><kbd>← →</kbd><span>{t('scroll')}</span></span>
          </>
        )}
        <i className="compare-hint-separator" aria-hidden="true" />
        <span className="compare-hint-item"><kbd>1–9</kbd><span>{t('label')}</span></span>
        <i className="compare-hint-separator" aria-hidden="true" />
        <span className="compare-hint-item"><kbd>{t('Esc')}</kbd></span>
      </footer>
    </div>
  )
}
