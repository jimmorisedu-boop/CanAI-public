import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type AssistantDoc, type AssistantPreset } from '../../api'
import type { CatalogModel } from '../../types'
import { IconClose, IconLLM, IconTrash, IconUpload } from '../../ui/icons'
import { showErrorToast, showToast } from './toastBus'
import { askConfirm } from '../../ui/confirmBus'

// Окно помощника: имя, инструкции (системный промпт), модель и документы.
// Нодовых скриптов здесь больше нет — решение пользователя 18.08.2026: нужно
// простое «включил — работает эта модель с этими инструкциями».
//
// Окно — тот же материал, что у «Поделиться» (.app-dialog*, см. share.css):
// липкая шапка с иконкой, заголовком и крестиком, прокручиваемое тело, ряд
// действий внизу. Своё окно я сперва собрал из .settings-modal, и оно
// выбилось из общего вида — крестик уехал под заголовок, а высота вылезла за
// экран.
//
// ⚠️ Рисуем ПОРТАЛОМ в body. У промпт-бара есть backdrop-filter, а он делает
// элемент containing block для position: fixed внутри — окно отсчитывалось от
// бара, а не от экрана, и уезжало вниз за край (жалоба 18.08.2026).

// ⚠️ Столько же знаков инструкций хранит сервер (MAX_INSTRUCTIONS_CHARS в
// server/src/assistantLimits.ts). Раньше у поля предела не было вовсе, и всё
// сверх серверного молча отрезалось при сохранении: человек видел в поле
// полный текст, а помощник работал с обрезанным. Поле считает единицами
// UTF-16, сервер — знаками; знаков не бывает больше, поэтому всё, что
// поместилось в поле, сервер сохранит целиком. Общего модуля у приложения и
// сервера нет — числа сверяет сторож в server/src/assistantsExchange.test.ts.
const INSTRUCTIONS_LIMIT = 24_000

export function AssistantPresetEditor({
  preset,
  models,
  onClose,
  onSaved,
  onDeleted,
}: {
  preset: AssistantPreset | null
  models: CatalogModel[]
  onClose(): void
  onSaved(saved: AssistantPreset): void
  onDeleted(id: string): void
}) {
  const textModels = models.filter((model) => model.kind === 'text')
  const [name, setName] = useState(preset?.name ?? '')
  const [instructions, setInstructions] = useState(preset?.instructions ?? '')
  const [modelId, setModelId] = useState(preset?.modelId ?? textModels[0]?.id ?? 'gemini')
  const [docs, setDocs] = useState<AssistantDoc[]>(preset?.docs ?? [])
  const [busy, setBusy] = useState(false)
  const [id, setId] = useState<string | null>(preset?.id ?? null)
  const fileRef = useRef<HTMLInputElement>(null)
  const titleId = useId()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save(): Promise<AssistantPreset> {
    const { preset: saved } = await api.saveAssistant({ id, name, instructions, modelId })
    setId(saved.id)
    return saved
  }

  async function submit(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      onSaved({ ...(await save()), docs })
      onClose()
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : "Failed to save assistant")
    } finally {
      setBusy(false)
    }
  }

  // Документ читаем ТЕКСТОМ: разбирать pdf и docx нечем, и принять такой файл
  // молча значило бы отдать модели мусор вместо знаний.
  async function attach(files: FileList | null): Promise<void> {
    if (!files || files.length === 0 || busy) return
    setBusy(true)
    try {
      // Файл прикладывается к УЖЕ сохранённому помощнику: до сохранения у него
      // нет id, и класть документ было бы некуда.
      const saved = id ? { id } : await save()
      for (const file of Array.from(files)) {
        const text = await file.text()
        if (!text.trim()) {
          showErrorToast(`"${file.name}" is empty or not text`)
          continue
        }
        const { doc } = await api.addAssistantDoc(saved.id, file.name, text)
        setDocs((current) => [...current, doc])
      }
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : "Failed to attach file")
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function detach(doc: AssistantDoc): Promise<void> {
    if (!id) return
    setDocs((current) => current.filter((item) => item.id !== doc.id))
    await api.removeAssistantDoc(id, doc.id).catch(() => showToast("The file was removed from the list only"))
  }

  return createPortal(
    <div className="app-dialog-backdrop" onClick={onClose}>
      <div
        className="app-dialog assistant-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="app-dialog-hero">
          <div className="app-dialog-icon"><IconLLM size={21} /></div>
          <div>
            <h2 id={titleId}>{preset ? "Assistant" : "New assistant"}</h2>
            <p>Instructions, model, and documents. Activate the assistant from its row.</p>
          </div>
          <button className="app-dialog-close" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </header>

        <label className="assistant-label" htmlFor={`${titleId}-name`}>Name</label>
        <input
          id={`${titleId}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name the assistant"
          maxLength={80}
          autoFocus
        />

        <label className="assistant-label" htmlFor={`${titleId}-instructions`}>Instructions</label>
        <textarea
          id={`${titleId}-instructions`}
          aria-label="Assistant instructions"
          className="assistant-instructions"
          value={instructions}
          maxLength={INSTRUCTIONS_LIMIT}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="What does this assistant do? How should it behave? What should it avoid?"
        />

        <label className="assistant-label" htmlFor={`${titleId}-model`}>Model</label>
        <select
          id={`${titleId}-model`}
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
        >
          {textModels.length === 0
            ? <option value="gemini">Gemini 3.8 Flash</option>
            : textModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>

        <label className="assistant-label">Knowledge</label>
        <p className="assistant-note">The assistant receives text files together with its instructions.</p>
        {docs.length > 0 && (
          <ul className="assistant-docs">
            {docs.map((doc) => (
              <li key={doc.id}>
                <span title={doc.name}>{doc.name}</span>
                <small>{doc.chars.toLocaleString('en-US')} signs</small>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${doc.name}`}
                  onClick={() => void detach(doc)}
                >
                  <IconTrash size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml,text/*"
          hidden
          onChange={(event) => void attach(event.target.files)}
        />
        <button
          type="button"
          className="editor-close assistant-upload"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <IconUpload size={16} />Upload files
        </button>

        <div className="assistant-actions">
          <button className="generate" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="editor-close" onClick={onClose}>Cancel</button>
          {id && (
            <button
              className="editor-close assistant-delete"
              disabled={busy}
              onClick={async () => {
                // Тот же переспрос, что в списке: помощник уносит с собой
                // инструкции и документы.
                const ok = await askConfirm({
                  title: `Delete "${name.trim() || "assistant"}"?`,
                  detail: docs.length > 0
                    ? `The instructions and ${docs.length} documents will disappear. It will not be possible to return it.`
                    : "The instructions will disappear. It will not be possible to return it.",
                  confirmLabel: "Delete",
                  cancelLabel: "Keep",
                  danger: true,
                })
                if (!ok) return
                await api.deleteAssistant(id).catch(() => {})
                onDeleted(id)
                onClose()
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
