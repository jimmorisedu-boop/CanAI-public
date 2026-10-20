import { useEffect, useRef, useState } from 'react'
import { IconRefresh, IconText } from '../../ui/icons'
import { isGifReference, type SelectionRef } from './konva/selection'
import { screenPreviewSrc } from './konva/screenPreview'
import { useRefChipPreview } from './RefChipPreview'
import { refChipFallback, retryRefSrc } from './refChipFallback'

export function shortText(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** Accessible copy used by both the tooltip and the retryable broken-chip
 * label. Keep the action in the same string so keyboard and screen-reader
 * users get an explicit recovery affordance, not just an error noun. */
export function refChipFailureLabel(broken: {
  name: string
  reason: string
  action: string
}): string {
  return `${broken.name}. ${broken.reason}. ${broken.action}`
}

export function RefChip({
  refItem,
  num,
  onRemove,
  onTag,
  onReplace,
  replacing = false,
  readOnly = false,
  gifUsage = 'neutral',
}: {
  refItem: SelectionRef
  num?: number // номер для inline-ссылки @n (только у медиа-референсов)
  onRemove: () => void
  onTag?: () => void
  onReplace?: () => void
  replacing?: boolean
  readOnly?: boolean
  gifUsage?: 'frame' | 'unsupported' | 'neutral'
}) {
  const tagTimerRef = useRef<number | null>(null)
  const isText = refItem.kind === 'text'
  const gifFrame = isGifReference(refItem)
  const gifHint = !gifFrame ? '' : gifUsage === 'frame'
    ? "Generation uses the first GIF frame, not the animation"
    : gifUsage === 'unsupported'
      ? "Online Assistant does not accept GIFs. Take a frame using the GIF button."
      : "GIF reference"
  // ⚠️ Сорвавшийся запрос миниатюры — обычное дело (браузер держит к одному
  // адресу шесть соединений), поэтому вместо значка битого файла показываем
  // плитку с именем и даём повторить. Подробности — в refChipFallback.ts.
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  // Сменился сам файл — прежняя неудача к нему отношения не имеет.
  useEffect(() => {
    setAttempt(0)
    setFailed(false)
  }, [refItem.src])
  const { anchorRef, hoverProps, preview } = useRefChipPreview(refItem, { disabled: failed })
  const broken = failed ? refChipFallback(refItem) : null
  const mediaSrc = refItem.src ? retryRefSrc(refItem.src, attempt) : undefined
  // A cloud asset can be several megabytes while a chip is only 26px. Ask the
  // same bounded screen preview as Konva does for both the active prompt and
  // read-only chat history; the source reference itself remains the original
  // URL for generation/export.
  const thumbnailSrc = refItem.kind === 'image'
    ? screenPreviewSrc(mediaSrc, 96)
    : mediaSrc

  function cancelPendingTag(): void {
    if (tagTimerRef.current == null) return
    window.clearTimeout(tagTimerRef.current)
    tagTimerRef.current = null
  }

  function retry(): void {
    cancelPendingTag()
    setFailed(false)
    setAttempt((value) => value + 1)
  }

  useEffect(() => cancelPendingTag, [])

  const content = (
    <>
      {!readOnly && num != null && <span className="ref-chip-num">{num}</span>}
      {broken ? (
        <span className="ref-chip-broken" aria-hidden="true">
          <IconRefresh size={14} />
        </span>
      ) : refItem.kind === 'image' && mediaSrc ? (
        <img src={thumbnailSrc} alt="" onError={() => setFailed(true)} />
      ) : refItem.kind === 'video' && mediaSrc ? (
        <video src={mediaSrc} playsInline muted onError={() => setFailed(true)} />
      ) : (
        <span className="ref-chip-icon">
          <IconText size={14} />
        </span>
      )}

      {isText && <span className="ref-chip-label">{shortText(refItem.label, 24)}</span>}
      {gifFrame && <span className="ref-chip-gif">{gifUsage === 'frame' ? "GIF frame" : 'GIF'}</span>}
      {/* Имя показываем именно у сорвавшегося чипа: у остальных его место
          занимает сама миниатюра, а тут занять его нечем. */}
      {broken && <span className="ref-chip-label">{shortText(broken.name, 24)}</span>}

      {preview}
    </>
  )

  // Пока миниатюра не загрузилась, чип отвечает на «почини», а не на «вставь
  // тег»: так и написано на самой плитке. Вернулась картинка — вернулось и
  // обычное поведение.
  const brokenLabel = broken ? refChipFailureLabel(broken) : ''

  if (readOnly) {
    // ⚠️ В ленте помощника повтор нужен не меньше — именно там человек и увидел
    // значки битых файлов. Но чип там лежит ВНУТРИ кнопки «вернуть в
    // референсы» (PromptChatReferenceHistory), поэтому своей роли кнопки у
    // него быть не может: кнопка в кнопке — недопустимая вложенность, и нажатие
    // срабатывало бы дважды. Клик гасим, чтобы сорвавшийся чип чинился, а не
    // возвращался в работу сломанным; клавиатура остаётся у внешней кнопки.
    return (
      <div
        className={`ref-chip${broken ? ' is-broken' : ''}`}
        ref={anchorRef}
        {...hoverProps}
        title={broken ? brokenLabel : gifHint || undefined}
        onClick={broken ? (e) => { e.stopPropagation(); e.preventDefault(); retry() } : undefined}
      >
        {content}
      </div>
    )
  }

  return (
    <div
      ref={anchorRef}
      {...hoverProps}
      className={`ref-chip${replacing ? ' is-replacing' : ''}${broken ? ' is-broken' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={
        broken
          ? `${brokenLabel} Delete with Delete or Backspace`
          : `${refItem.label}. ${gifHint ? `${gifHint}. ` : ''}${num ? `Insert @${num} with Enter. ` : ''}${onReplace ? "Replace by double clicking or Shift+Enter." : ''}Delete with Delete or Backspace`
      }
      title={
        broken
          ? `${broken.reason}
Left-click to retry loading${onReplace ? "Double click - replace reference" : ''}
Right-click to remove from references`
          : num
            ? `${gifHint ? `${gifHint}\n` : ''}Left-click to insert @${num} in the prompt${onReplace ? "Double click - replace reference" : ''}
Right-click to remove from references`
            : `${gifHint ? `${gifHint}\n` : ''}${onReplace ? "Double click - replace reference" : ''}Right-click to remove from references`
      }
      onClick={(e) => {
        if (e.button !== 0) return
        if (broken) {
          retry()
          return
        }
        if (onTag) {
          if (!onReplace) {
            onTag()
            return
          }
          cancelPendingTag()
          tagTimerRef.current = window.setTimeout(() => {
            tagTimerRef.current = null
            onTag()
          }, 200)
        }
      }}
      onDoubleClick={(e) => {
        if (e.button !== 0 || !onReplace) return
        e.preventDefault()
        cancelPendingTag()
        onReplace()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.shiftKey && onReplace) {
          e.preventDefault()
          cancelPendingTag()
          onReplace()
        } else if (e.key === 'Enter' && broken) {
          e.preventDefault()
          retry()
        } else if (e.key === 'Enter' && onTag) {
          e.preventDefault()
          onTag()
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          e.stopPropagation()
          onRemove()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onRemove()
      }}
    >
      {content}
    </div>
  )
}
