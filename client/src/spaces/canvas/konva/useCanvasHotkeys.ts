import { useEffect, useRef, useState } from 'react'
import type { CanvasStore } from './canvasStore'
import { copySelected, hasClipboard, paste } from './clipboard'
import { zoomToFit } from './cameraOps'
import { canvasPasteArbiter } from './pasteArbiter'
import { getCompareSession, startComparePicking } from '../compare/compareBus'
import { getTimelineTarget, setTimelineTarget, timelineBlocksCanvas } from '../timeline/timelineBus'
import { isMarkDigit, markStep, MARK_COMMIT_MS } from './markInput'
import { hits } from '../../../ui/hotkeys'
import { archiveSelection, archiveTargets } from './archiveSelection'
import { runWithBoardLease } from './boardLeaseActions'
import { browserSelectedText, canvasOwnsCopy } from './canvasCopyOwnership'

// Полями ввода считаем только настоящие поля. Кнопки в этот список входить не
// должны: после клика по «Видео» или зуму фокус остаётся на кнопке, и Delete,
// Ctrl+Z и цифры-метки молча переставали работать до клика по холсту — хоткеи
// выглядели «через раз», а причина была невидима.
function isTyping(e: Pick<Event, 'target'>): boolean {
  const t = e.target as HTMLElement | null
  return Boolean(t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable))
}

// ...но пробел на сфокусированной кнопке принадлежит ЕЙ: браузер активирует
// кнопку пробелом, и наш preventDefault ради панорамы отнял бы это у клавиатуры.
function ownsSpace(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return Boolean(t && ['BUTTON', 'A', 'SUMMARY'].includes(t.tagName))
}

// Горячие клавиши холста (Figma-модель) + состояние «Space зажат» для
// панорамирования рукой. active=false (скетч/кроп) отключает всё, кроме Space.
export function useCanvasHotkeys(
  store: CanvasStore,
  active: boolean,
  viewport: { w: number; h: number },
  getMouseWorld?: () => { x: number; y: number } | undefined,
): boolean {
  const [spaceHeld, setSpaceHeld] = useState(false)

  // буфер ввода метки: копится, пока не истечёт пауза или не наберётся 3 цифры
  const markBuffer = useRef('')
  const markIds = useRef<string[]>([])
  const markTimer = useRef<number | null>(null)

  function commitMarkBuffer(): void {
    markBuffer.current = ''
    markIds.current = []
    if (markTimer.current !== null) {
      window.clearTimeout(markTimer.current)
      markTimer.current = null
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return
      if (document.querySelector('.settings-backdrop')) return
      // Пока открыто сравнение (набор или просмотр), клавиатура принадлежит
      // ему целиком. Иначе пробел уходил в панораму вместо видео, а Delete
      // УДАЛЯЛ выделенное на холсте вместо отправки кандидата в архив.
      if (getCompareSession()) return
      // Та же причина у таймлайна: пока открыт режим правки клипа, Delete
      // не должен удалять объекты с холста, а Enter — применять что-то ещё.
      // ⚠️ Спрашиваем «держит ли режим холст», а не «есть ли цель»: в
      // презентации «холст» (клавиша G) оверлей спрятан, цель в шине жива, а
      // человек разглядывает снятый кадр на доске — и хоткеи обязаны работать.
      if (timelineBlocksCanvas()) return
      // Но Escape там принадлежит оверлею: он вернёт себя. Холст не должен
      // заодно снять выделение с кадра, который человек только что открыл.
      if (e.key === 'Escape' && getTimelineTarget()) return

      if (e.code === 'Space') {
        if (ownsSpace(e)) return
        // не даём странице скроллиться; повторные события игнорируем
        e.preventDefault()
        setSpaceHeld(true)
        return
      }
      if (!active) return

      const mod = e.ctrlKey || e.metaKey

      // Клавиши распознаёт реестр (ui/hotkeys): там же лежит их описание для
      // справки, поэтому справка физически не может отстать от поведения.
      const isUndo = hits('canvas.undo', e)
      const isRedo = hits('canvas.redo', e)
      const isPaste = hits('canvas.paste', e)
      const isCut = hits('canvas.cut', e)
      const isDuplicate = hits('canvas.duplicate', e)
      const isSelectAll = hits('canvas.selectAll', e)

      // Q — сравнение: выделенный объект становится исходником и открывается
      // набор кандидатов. Разбор клавиши переехал в реестр: раньше он жил
      // здесь вручную, а сторож прощал его по НОМЕРУ СТРОКИ — стоило вставить
      // выше ещё один хоткей, и прощение перестало действовать.
      const isCompare = hits('compare.start', e)

      // T — правка клипа: открывает таймлайн для выделенного видео.
      // Раскладки и коды разбирает реестр hotkeys, а не эта ветка.
      if (hits('canvas.timeline', e)) {
        const clip = [...store.getSelectedIds()]
          .map((id) => store.getItem(id))
          .find((item) => item?.kind === 'video')
        if (!clip) return
        // Режим уже открыт (мы в презентации «холст»): другой клип подменил бы
        // цель, и резы, кроп и кадры живого сеанса пропали бы без вопросов.
        if (getTimelineTarget()) return
        e.preventDefault()
        setTimelineTarget(clip.id)
      } else if (isCompare) {
        const baseline = [...store.getSelectedIds()]
          .map((id) => store.getItem(id))
          .find((item) => item && (item.kind === 'image' || item.kind === 'video'))
        if (!baseline) return
        e.preventDefault()
        startComparePicking(baseline.id)
      } else if (isUndo) {
        e.preventDefault()
        store.undo()
      } else if (isRedo) {
        e.preventDefault()
        store.redo()
      } else if (isCut) {
        if (store.getSelectedIds().size > 0) {
          e.preventDefault()
          copySelected(store)
          runWithBoardLease(store, [...store.getSelectedIds()], () => store.removeSelected())
        }
      } else if (isPaste) {
        if (hasClipboard()) {
          const mouseWorld = getMouseWorld?.()
          canvasPasteArbiter.schedule(() => paste(store, mouseWorld, viewport))
        }
      } else if (isDuplicate) {
        e.preventDefault()
        store.duplicateSelected()
      } else if (isSelectAll) {
        e.preventDefault()
        store.selectAll()
      } else if (hits('canvas.archive', e)) {
        // тот же путь, что у перетаскивания на плитку: жест перестал быть
        // единственным способом попасть в архив (F-16)
        const ids = archiveTargets(store)
        if (ids.length > 0) {
          e.preventDefault()
          runWithBoardLease(store, ids, () => { archiveSelection(store, ids) })
        }
      } else if (hits('canvas.delete', e)) {
        if (store.getSelectedIds().size > 0) {
          e.preventDefault()
          // ⚠️ Аренда берётся на месте — см. boardLeaseActions: истёкшая молча
          // превращала Delete в пустое нажатие.
          runWithBoardLease(store, [...store.getSelectedIds()], () => store.removeSelected())
        }
      } else if (!mod && !e.altKey && !e.shiftKey && isMarkDigit(e.key)) {
        // цифра без модификаторов помечает выделение (правила — в markInput.ts)
        const ids = markBuffer.current ? markIds.current : [...store.getSelectedIds()]
        if (ids.length === 0) return
        e.preventDefault()

        const step = markStep(markBuffer.current, e.key)
        markIds.current = ids
        markBuffer.current = step.buffer
        store.setMarks(ids, step.mark, step.isFirstDigit)

        if (markTimer.current !== null) window.clearTimeout(markTimer.current)
        if (step.commit) commitMarkBuffer()
        else markTimer.current = window.setTimeout(commitMarkBuffer, MARK_COMMIT_MS)
      } else if (e.key === 'Escape') {
        commitMarkBuffer()
        store.clearSelection()
      } else if (hits('canvas.zoomToFit', e)) {
        // Shift+1 — вписать всё (как в Figma)
        e.preventDefault()
        zoomToFit(store, viewport)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    const onCopy = (e: ClipboardEvent) => {
      if (!active || isTyping(e) || !canvasOwnsCopy({
        selectedCanvasItems: store.getSelectedIds().size,
        selectedText: browserSelectedText(),
      })) return
      e.preventDefault()
      copySelected(store, e.clipboardData ?? undefined)
    }
    const onBlur = () => setSpaceHeld(false)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('copy', onCopy)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('blur', onBlur)
      canvasPasteArbiter.cancel()
      if (markTimer.current !== null) {
        window.clearTimeout(markTimer.current)
        markTimer.current = null
      }
    }
  }, [store, active, viewport.w, viewport.h])

  return spaceHeld
}
