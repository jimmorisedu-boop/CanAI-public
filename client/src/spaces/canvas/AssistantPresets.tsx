import { useCallback, useEffect, useState } from 'react'
import { api, type AssistantPreset } from '../../api'
import type { CatalogModel } from '../../types'
import { AssistantLibrary } from './AssistantLibrary'
import { AssistantPresetEditor } from './AssistantPresetEditor'
import { macroShortLabel } from './macroShortLabel'
import { showErrorToast, showToast } from './toastBus'
import { buildAssistantFile, readAssistantFile, resolveAssistantModel } from './assistantFile'
import { libraryFileName } from './libraryFile'
import { pickLibraryFile, saveLibraryFile } from './libraryFileIO'
import { askConfirm } from '../../ui/confirmBus'
import type { ProjectSource } from '../../types'
import type { LibraryNotice } from './useMacroLibraryActions'
import { AssistantPicker, type AssistantPickerItem, type AssistantPickerVariant } from './AssistantPicker'
import { useT } from '../../i18n/context.js'


// Ряд помощников — ТА ЖЕ структура, что у макросов в окне промпта: короткая
// подпись на кнопке, а в конце «⋯» с полным списком (правка, удаление,
// добавление). Одинаковые с виду ряды обязаны и вести себя одинаково.
//
// Отличие одно и оно по смыслу: кнопка здесь ПЕРЕКЛЮЧАТЕЛЬ, а не запуск.
// Включил — и дальше вопросы уходят его моделью, с его инструкциями и
// документами. Включён ровно один или ни одного; повторное нажатие выключает.

export interface AssistantSelectionInfo {
  id: string | null
  versionId: string | null
  name?: string | null
  modelId?: string | null
}

export function AssistantPresets({
  models, projectSource = 'local', onCloudAssistantChanged, variant = 'shelf', onChanged, onSelectionChanged, manage = true,
}: {
  models: CatalogModel[]
  projectSource?: ProjectSource
  /** Compact selector for the action dock; shelf keeps the existing row. */
  variant?: AssistantPickerVariant
  /** Whether management / settings action is enabled. */
  manage?: boolean
  /** На сетевой доске сменился тот, кто ответит: открытый диалог пора перечитать. */
  onCloudAssistantChanged?(): void
  /** Optional notification for consumers that cache the active local profile. */
  onChanged?(): void
  /** Snapshot the selected helper before a separate text-preparation request. */
  onSelectionChanged?(selection: AssistantSelectionInfo): void
}) {
  return <LocalAssistantPresets models={models} variant={variant} onChanged={onChanged} onSelectionChanged={onSelectionChanged} manage={manage} />
}

function LocalAssistantPresets({ models, variant = 'shelf', onChanged, onSelectionChanged, manage = true }: { models: CatalogModel[]; variant?: AssistantPickerVariant; onChanged?(): void; onSelectionChanged?(selection: AssistantSelectionInfo): void; manage?: boolean }) {
  const t = useT()
  const [presets, setPresets] = useState<AssistantPreset[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ preset: AssistantPreset | null } | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [libraryNotice, setLibraryNotice] = useState<LibraryNotice | null>(null)

  const reload = useCallback(() => {
    api.listAssistants()
      .then((state) => {
        const sorted = [...state.presets].sort((a, b) => a.slot - b.slot)
        setPresets(sorted)
        setActiveId(state.activeId)
        const active = sorted.find((preset) => preset.id === state.activeId)
        onSelectionChanged?.({
          id: state.activeId,
          versionId: null,
          name: active?.name ?? (state.activeId ? null : t('Universal')),
          modelId: active?.modelId ?? null,
        })
      })
      .catch((cause) => {
        showErrorToast(cause instanceof Error ? cause.message : t('Failed to load helpers'))
      })
  }, [onSelectionChanged, t])

  useEffect(reload, [reload])

  async function toggle(preset: AssistantPreset): Promise<void> {
    const next = activeId === preset.id ? null : preset.id
    // Показываем сразу: переключатель обязан отзываться на нажатие, а не ждать
    // сервер. Если он откажет, вернём как было.
    const previous = activeId
    setActiveId(next)
    const nextPreset = next ? preset : null
    onSelectionChanged?.({
      id: next,
      versionId: null,
      name: nextPreset?.name ?? (next ? null : t('Universal')),
      modelId: nextPreset?.modelId ?? null,
    })
    try {
      const active = (await api.setActiveAssistant(next)).activeId
      setActiveId(active)
      const confirmed = presets.find((p) => p.id === active)
      onSelectionChanged?.({
        id: active,
        versionId: null,
        name: confirmed?.name ?? (active ? null : t('Universal')),
        modelId: confirmed?.modelId ?? null,
      })
      onChanged?.()
    } catch (cause) {
      setActiveId(previous)
      const prevPreset = previous ? presets.find((p) => p.id === previous) : null
      onSelectionChanged?.({
        id: previous,
        versionId: null,
        name: prevPreset?.name ?? (previous ? null : t('Universal')),
        modelId: prevPreset?.modelId ?? null,
      })
      showErrorToast(cause instanceof Error ? cause.message : t('Failed to switch assistant'))
    }
  }

  const pickerItems: AssistantPickerItem[] = presets.map((preset) => ({ id: preset.id, name: preset.name, scope: 'personal' }))
  const selectCompact = async (id: string | null): Promise<void> => {
    if (id === null) {
      if (activeId === null) return
      const active = presets.find((preset) => preset.id === activeId)
      if (active) await toggle(active)
      return
    }
    const preset = presets.find((candidate) => candidate.id === id)
    if (preset) await toggle(preset)
  }

  // Переименование правит ТОЛЬКО имя: инструкции и модель передаём как есть,
  // иначе сохранение затёрло бы их пустыми значениями.
  async function rename(preset: AssistantPreset, name: string): Promise<void> {
    try {
      await api.saveAssistant({
        id: preset.id,
        name,
        instructions: preset.instructions,
        modelId: preset.modelId,
      })
      reload()
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : t('Failed to rename assistant'))
    }
  }

  // Копию делает сервер: вместе с пресетом надо скопировать файлы документов.
  async function duplicate(preset: AssistantPreset): Promise<void> {
    try {
      await api.duplicateAssistant(preset.id)
      reload()
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : t('Failed to duplicate assistant'))
    }
  }

  async function remove(preset: AssistantPreset): Promise<void> {
    // Спрашиваем, как при удалении макроса: вместе с помощником пропадут его
    // инструкции и приложенные документы, а вернуть их будет неоткуда.
    const ok = await askConfirm({
      title: t('Delete "{0}"?', { 0: preset.name }),
      detail: preset.docs.length > 0
        ? t('The instructions and {0} documents will disappear. It will not be possible to return it.', { 0: preset.docs.length })
        : t('The instructions will disappear. It will not be possible to return it.'),
      confirmLabel: t('Delete'),
      cancelLabel: t('Keep'),
      danger: true,
    })
    if (!ok) return
    await api.deleteAssistant(preset.id).catch((cause) => {
      showErrorToast(cause instanceof Error ? cause.message : t('Failed to remove assistant'))
    })
    reload()
  }

  // Сохранить в файл и загрузить из файла: так помощником делятся с коллегой
  // и переносят его на сетевую доску. Файл несёт и тексты документов знаний.
  async function exportFile(preset: AssistantPreset): Promise<void> {
    setLibraryError(null)
    try {
      const full = await api.exportAssistant(preset.id)
      saveLibraryFile(libraryFileName(preset.name, 'assistant'), buildAssistantFile(full, models))
      showToast(t('"{0}" saved to file', { 0: preset.name }))
    } catch (cause) {
      // Строкой в окне: отказ тут бывает длинным («не помещается в файл —
      // уберите часть документов»), за две секунды всплывашки его не прочесть.
      setLibraryError(cause instanceof Error ? cause.message : t('Failed to save helper to file'))
    }
  }

  // ⚠️ Итог и отказ — строкой в самом окне. «Из файла» жмут в открытом окне
  // помощников, а всплывашка жила две секунды: что заменено или урезано,
  // прочесть было нельзя, а отказ («Это не файл помощника») выглядел как
  // «нажал — и ничего не произошло».
  async function importFile(): Promise<void> {
    setLibraryError(null)
    try {
      const text = await pickLibraryFile()
      if (text === null) return
      const file = readAssistantFile(text)
      const model = resolveAssistantModel(file, models.filter((item) => item.kind === 'text'), null)
      const imported = await api.importAssistant({
        name: file.name, instructions: file.instructions, modelId: model.modelId, docs: file.docs,
      })
      reload()
      const notes = [model.note, ...(imported.notes ?? [])].filter((note): note is string => Boolean(note))
      if (notes.length > 0) {
        setLibraryNotice({ tone: 'info', title: t('Assistant "{0}" is loaded. What has changed:', { 0: file.name }), lines: notes })
      } else {
        showToast(t('Assistant "{0}" loaded', { 0: file.name }))
      }
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : t('Failed to load helper from file'))
    }
  }

  return (
    <div className="assistant-macros" role="group" aria-label={t('Assistants')}>
      {variant === 'compact' ? (
        <AssistantPicker
          items={pickerItems}
          activeId={activeId}
          variant="compact"
          onSelect={selectCompact}
          onManage={manage ? () => setLibraryOpen(true) : undefined}
          manageLabel={t('Configure')}
          manage={manage}
        />
      ) : <div className="macros-inline">
        <button
          type="button"
          className={`macros-inline-btn${activeId === null ? ' on' : ''}`}
          aria-pressed={activeId === null}
          aria-label={t('Enable Universal Assistant')}
          title={t('Universal assistant')}
          onClick={() => void selectCompact(null)}
          onMouseDown={(event) => event.preventDefault()}
        >
          <span className="macro-slot-name">{macroShortLabel(t('Universal'))}</span>
        </button>
        {presets.map((preset) => {
          const on = activeId === preset.id
          return (
            <div key={preset.id} className="macro-control">
              <button
                type="button"
                className={`macros-inline-btn${on ? ' on' : ''}`}
                aria-pressed={on}
                title={
                  on
                    ? t('"{0}" is enabled - right click to change', { 0: preset.name })
                    : t('Enable "{0}" - right click to change', { 0: preset.name })
                }
                aria-label={on ? t('Disable assistant {0}', { 0: preset.name }) : t('Enable assistant {0}', { 0: preset.name })}
                onClick={() => void toggle(preset)}
                onMouseDown={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  if (event.key === 'F2') {
                    event.preventDefault()
                    setEditing({ preset })
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setEditing({ preset })
                }}
              >
                <span className="macro-slot-name">{macroShortLabel(preset.name)}</span>
              </button>
            </div>
          )
        })}
        {manage && (
          <button
            type="button"
            className="macros-inline-btn more"
            title={t('Manage assistants: edit, delete, add')}
            aria-label={t('Manage assistants')}
            onClick={() => setLibraryOpen(true)}
          >
            ⋯
          </button>
        )}
      </div>}

      {libraryOpen && (
        <AssistantLibrary
          presets={presets}
          activeId={activeId}
          error={libraryError}
          notice={libraryNotice}
          onDismissError={() => setLibraryError(null)}
          onDismissNotice={() => setLibraryNotice(null)}
          onClose={() => {
            setLibraryOpen(false)
            setLibraryError(null)
            setLibraryNotice(null)
          }}
          onCreate={() => {
            setLibraryOpen(false)
            setEditing({ preset: null })
          }}
          onEdit={(preset) => {
            setLibraryOpen(false)
            setEditing({ preset })
          }}
          onRename={(preset, name) => void rename(preset, name)}
          onDuplicate={(preset) => void duplicate(preset)}
          onDelete={(preset) => void remove(preset)}
          onExport={(preset) => void exportFile(preset)}
          onImport={() => void importFile()}
        />
      )}

      {editing && (
        <AssistantPresetEditor
          preset={editing.preset}
          models={models}
          onClose={() => setEditing(null)}
          onSaved={reload}
          onDeleted={reload}
        />
      )}
    </div>
  )
}
