import type { KeyboardEvent, RefObject } from 'react'
import { IconText, IconVideo } from '../../ui/icons'
import type { SelectionRef } from './konva/selection'
import { shortText } from './RefChip'
import { screenPreviewSrc } from './konva/screenPreview'
import { useT } from '../../i18n/context.js'


// id списка @-подсказки и его пунктов: поле ссылается на активный пункт через
// aria-activedescendant, поэтому имена нужны обеим сторонам
const MENTION_LIST_ID = 'prompt-mention-listbox'
const mentionOptionId = (index: number) => `prompt-mention-option-${index}`

export interface MentionState {
  index: number
}

// Поле ввода промпт-бара вместе с @-подсказкой. Одно на всё приложение: и
// промпт генерации, и вопрос помощнику пишут здесь же (решение пользователя —
// ради места на холсте). Компонент ничего не решает сам: что показывать в
// подсказке, считает promptPlaceholder, а что делать с выбранным пунктом —
// промпт-бар.
export function PromptComposerField({
  textareaRef,
  value,
  placeholder,
  ariaLabel,
  mention,
  mentionList,
  mediaRefs,
  onChange,
  onCaretMove,
  onFocus,
  onBlur,
  onKeyDown,
  onMentionHover,
  onMentionPick,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>
  value: string
  placeholder: string
  ariaLabel: string
  // null — подсказка закрыта; index указывает на активный пункт mentionList
  mention: MentionState | null
  mentionList: SelectionRef[]
  // полный набор медиа-референсов: по нему считается номер @n
  mediaRefs: SelectionRef[]
  onChange(value: string, selectionStart: number, selectionEnd: number): void
  onCaretMove(value: string, selectionStart: number, selectionEnd: number): void
  onFocus(): void
  onBlur(field: HTMLTextAreaElement): void
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void
  onMentionHover(index: number): void
  onMentionPick(ref: SelectionRef): void
}) {
  const t = useT()
  const open = mention !== null && mentionList.length > 0

  return (
    <div className="prompt-input-wrap">
      <textarea
        ref={textareaRef}
        rows={2}
        /* плейсхолдер исчезает с первой буквой — подписью он быть не может.
           Название поля постоянное и говорит, куда именно уйдёт текст. */
        aria-label={ariaLabel}
        /* @-подсказка: поле остаётся полем ввода (textbox умеет
           activedescendant), список живёт рядом и не забирает фокус */
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? MENTION_LIST_ID : undefined}
        aria-activedescendant={open && mention ? mentionOptionId(mention.index) : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          const next = event.target.value
          onChange(
            next,
            event.target.selectionStart ?? next.length,
            event.target.selectionEnd ?? next.length,
          )
        }}
        onKeyUp={(event) => onCaretMove(
          event.currentTarget.value,
          event.currentTarget.selectionStart ?? 0,
          event.currentTarget.selectionEnd ?? 0,
        )}
        onClick={(event) => onCaretMove(
          event.currentTarget.value,
          event.currentTarget.selectionStart ?? 0,
          event.currentTarget.selectionEnd ?? 0,
        )}
        onFocus={onFocus}
        onBlur={(event) => onBlur(event.currentTarget)}
        onKeyDown={onKeyDown}
      />
      {open && mention && (
        /* список выбирают стрелками из самого поля, поэтому он не забирает
           фокус: роли и aria-activedescendant делают это слышимым */
        <div className="mention-popup" id={MENTION_LIST_ID} role="listbox" aria-label={t('References for link')}>
          <div className="mention-hint" role="presentation">{t('Reference an item')}</div>
          {mentionList.map((ref, index) => (
            <button
              key={ref.shapeId}
              id={mentionOptionId(index)}
              type="button"
              role="option"
              aria-selected={index === mention.index}
              tabIndex={-1}
              className={`mention-item ${index === mention.index ? 'active' : ''}`}
              onMouseEnter={() => onMentionHover(index)}
              onMouseDown={(event) => {
                event.preventDefault() // не терять фокус/каретку textarea
                onMentionPick(ref)
              }}
            >
              <span className="mention-num">
                {mediaRefs.findIndex((media) => media.shapeId === ref.shapeId) + 1}
              </span>
              {ref.kind === 'image' && ref.src ? (
                // Строка списка — миниатюра, а не оригинал: у сетевой доски
                // оригинал ехал бы по сети целиком (находка Ф-1 аудита).
                <img src={screenPreviewSrc(ref.src, 64)} alt="" />
              ) : (
                <span className="mention-icon">
                  {ref.kind === 'video' ? <IconVideo size={14} /> : <IconText size={14} />}
                </span>
              )}
              <span className="mention-label">{shortText(ref.label, 30)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
