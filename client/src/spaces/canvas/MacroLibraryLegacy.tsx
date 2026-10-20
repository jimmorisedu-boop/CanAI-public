import type { Macro } from '../../api'
import { IconTrash } from '../../ui/icons'
import { describeMacro } from './macroLibraryModel'

// Макросы из области, которой в приложении больше нет (цепочки помощника).
// Прятать их нельзя: такой макрос не открыть и не удалить, а ссылки на медиа
// он держит и уборке мешает. Показываем отдельным разделом с одной кнопкой.
export function MacroLibraryLegacy({
  macros, unit, busy, onRemove,
}: {
  macros: Macro[]
  unit: [string, string, string]
  busy: boolean
  onRemove(macro: Macro): void
}) {
  if (macros.length === 0) return null
  return (
    <>
      <div className="macro-lib-section warn">Left over from the previous version</div>
      {macros.map((macro) => (
        <article className="macro-lib-row orphan" key={macro.id}>
          <span className="macro-lib-slot none" aria-hidden="true">—</span>
          <div className="macro-lib-name">
            <strong>{macro.name}</strong>
            <small className="warn">
              {describeMacro({ orphan: true, legacy: true, ready: false, nodeCount: 0, unit })}
            </small>
          </div>
          <button
            type="button"
            className="icon-btn macro-lib-act danger"
            aria-label={`Delete "${macro.name}"`}
            title="Delete"
            disabled={busy}
            onClick={() => onRemove(macro)}
          >
            <IconTrash size={15} />
          </button>
        </article>
      ))}
    </>
  )
}
