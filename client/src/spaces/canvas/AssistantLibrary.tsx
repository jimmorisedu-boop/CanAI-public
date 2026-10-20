import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AssistantPreset } from '../../api'
import { IconClose, IconDownload, IconDuplicate, IconEdit, IconPlus, IconTrash, IconUpload } from '../../ui/icons'
import { useDialogFocus } from '../../ui/dialogFocus'
import { InlineNotice } from '../../ui/InlineNotice'
import { pluralWithCount } from '../../ui/plural'
import type { LibraryNotice } from './useMacroLibraryActions'

// «⋯» в конце ряда помощников — то же окно, что у макросов холста
// (.modal-card .macro-lib): список, действия в строке и кнопка добавления.
// Одинаковые с виду списки обязаны и вести себя одинаково, поэтому набор
// действий тут ровно тот же: переименовать, дублировать, сохранить в файл,
// удалить (просьба пользователя 19.08.2026). Открывается помощник кликом по
// самой строке.
//
// Рисуем ПОРТАЛОМ в body по той же причине, что и остальные окна отсюда: у
// промпт-бара есть backdrop-filter, и position: fixed внутри него считается
// от бара, а не от экрана.

export function AssistantLibrary({
  presets,
  activeId,
  error,
  notice,
  onDismissError,
  onDismissNotice,
  onClose,
  onCreate,
  onEdit,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
  onImport,
}: {
  presets: AssistantPreset[]
  activeId: string | null
  /** Отказ и итог «Из файла» — строкой в окне: всплывашку за две секунды не прочесть. */
  error: string | null
  notice: LibraryNotice | null
  onDismissError(): void
  onDismissNotice(): void
  onClose(): void
  onCreate(): void
  onEdit(preset: AssistantPreset): void
  onRename(preset: AssistantPreset, name: string): void
  onDuplicate(preset: AssistantPreset): void
  onDelete(preset: AssistantPreset): void
  onExport(preset: AssistantPreset): void
  onImport(): void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function startRename(preset: AssistantPreset): void {
    setRenamingId(preset.id)
    setRenameValue(preset.name)
  }

  function commitRename(preset: AssistantPreset): void {
    const name = renameValue.trim()
    setRenamingId(null)
    // Пустое имя — не переименование, а потеря имени: молча оставляем прежнее.
    if (name && name !== preset.name) onRename(preset, name)
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-card macro-lib"
        role="dialog"
        aria-modal="true"
        aria-label="All assistants"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="macro-lib-head">
          <h3>All assistants</h3>
          <span className="macro-lib-count">{presets.length}</span>
          <button className="macro-lib-close" type="button" aria-label="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        {error && (
          <InlineNotice className="macro-lib-error" tone="error" title={error} onDismiss={onDismissError} />
        )}
        {notice && (
          <InlineNotice className="macro-lib-notice" tone={notice.tone} title={notice.title} onDismiss={onDismissNotice}>
            {notice.lines.length > 0 && (
              <ul>{notice.lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>
            )}
          </InlineNotice>
        )}

        {presets.length === 0 ? (
          <p className="macro-lib-note">Nothing here yet. An assistant combines instructions, a model, and documents.</p>
        ) : (
          presets.map((preset) => (
            <div className={`macro-lib-row${activeId === preset.id ? ' active' : ''}`} key={preset.id}>
              <span className="macro-lib-slot" aria-hidden="true">{activeId === preset.id ? '●' : '○'}</span>
              {/* Кнопка открытия — прозрачная подложка на всю строку, а текст
                  лежит поверх неё. Ровно как у макросов: обернёшь текст в
                  кнопку — и ряд иконок уезжает влево, потому что имя перестаёт
                  занимать свободное место (жалоба 19.08.2026). */}
              <button
                type="button"
                className="macro-lib-open"
                aria-label={`Open "${preset.name}"`}
                title="Open assistant"
                onClick={() => onEdit(preset)}
              />
              <div className="macro-lib-text">
                {renamingId === preset.id ? (
                  <input
                    className="macro-lib-rename"
                    value={renameValue}
                    autoFocus
                    maxLength={80}
                    aria-label="New name"
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => commitRename(preset)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename(preset)
                      if (event.key === 'Escape') setRenamingId(null)
                    }}
                  />
                ) : (
                  <strong>{preset.name}</strong>
                )}
                <small>
                  {preset.docs.length > 0 ? pluralWithCount(preset.docs.length, ["document", "document", "documents"]) : "no documents"}
                  {activeId === preset.id ? " · enabled" : ''}
                </small>
              </div>
              <button
                type="button"
                className="icon-btn macro-lib-act"
                aria-label={`Rename ${preset.name}`}
                title="Rename"
                onClick={() => startRename(preset)}
              >
                <IconEdit size={15} />
              </button>
              <button
                type="button"
                className="icon-btn macro-lib-act"
                aria-label={`Duplicate ${preset.name}`}
                title="Duplicate"
                onClick={() => onDuplicate(preset)}
              >
                <IconDuplicate size={15} />
              </button>
              <button
                type="button"
                className="icon-btn macro-lib-act"
                aria-label={`Save ${preset.name} to file`}
                title="Save to a file — you can share it with a colleague"
                onClick={() => onExport(preset)}
              >
                <IconDownload size={15} />
              </button>
              <button
                type="button"
                className="icon-btn macro-lib-act danger"
                aria-label={`Delete ${preset.name}`}
                title="Delete"
                onClick={() => onDelete(preset)}
              >
                <IconTrash size={15} />
              </button>
            </div>
          ))
        )}

        <footer className="macro-lib-footer">
          <button className="macro-lib-add" type="button" onClick={onCreate}>
            <IconPlus size={15} />Add assistant
          </button>
          <button className="macro-lib-add" type="button" title="Upload assistant from file" onClick={onImport}>
            <IconUpload size={15} />From file
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
