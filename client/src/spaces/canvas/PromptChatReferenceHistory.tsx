import type { SelectionRef } from './konva/selection'
import { RefChip } from './RefChip'
import { useT } from '../../i18n/context.js'


// Миниатюры референсов под сообщением. Клик по любой возвращает её в работу:
// объект выделяется на доске и тем самым становится референсом промпта
// (просьба пользователя 20.08.2026). Ctrl или Shift — добавить к выделению,
// как на самом холсте.
export function PromptChatReferenceHistory({
  refs,
  onPick,
}: {
  refs: SelectionRef[]
  onPick?: (ref: SelectionRef, additive: boolean) => void
}) {
  const t = useT()
  if (refs.length === 0) return null

  return (
    <div className="prompt-chat-reference-history ref-chips">
      {refs.map((ref) => (
        <button
          key={ref.shapeId}
          type="button"
          className="prompt-chat-ref-pick"
          // Без обработчика ведём себя как раньше — просто картинка.
          disabled={!onPick}
          title={t('Return to references and select on the board (Ctrl - add to selection)')}
          aria-label={t('Return to references: {0}', { 0: ref.label })}
          onClick={(event) => onPick?.(ref, event.ctrlKey || event.metaKey || event.shiftKey)}
        >
          <RefChip refItem={ref} onRemove={() => {}} readOnly />
        </button>
      ))}
    </div>
  )
}
