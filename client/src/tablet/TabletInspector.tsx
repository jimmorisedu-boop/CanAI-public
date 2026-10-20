import { useContentVersion } from '../spaces/canvas/konva/useStore'
import { useState } from 'react'
import {
  IconArchive,
  IconSketch,
  IconClose,
  IconCompare,
  IconCrop,
  IconDownload,
  IconDuplicate,
  IconFit,
  IconFitAll,
  IconPin,
  IconSound,
  IconText,
  IconTimeline,
  IconToBack,
  IconToFront,
  IconTrash,
} from '../ui/icons'
import type { CanvasStore } from '../spaces/canvas/konva/canvasStore'
import type { CanvasItem } from '../spaces/canvas/konva/types'
import { previewSrc } from './remoteSession'
import {
  ACTION_LABEL,
  actionSection,
  actionsForItem,
  actionsForMany,
  subjectDetails,
  subjectTitle,
  type InspectorAction,
} from './inspectorModel'
import { TabletArrangeControls } from './TabletArrangeControls'

// Инспектор выделенного.
//
// На компьютере действия объекта живут в панельке, которая висит над ним и
// уезжает вместе с ним. Пальцем в такую панельку не попасть, поэтому здесь она
// стоит у правого края и не двигается. Появляется только по выделению — холст
// не делится ни с чем постоянным.

const ICONS: Record<InspectorAction, React.ReactNode> = {
  view: <IconFit size={20} />,
  resize: <IconFitAll size={20} />,
  sketch: <IconSketch size={20} />,
  crop: <IconCrop size={20} />,
  clip: <IconTimeline size={20} />,
  'extract-audio': <IconSound size={20} />,
  compare: <IconCompare size={20} />,
  'edit-text': <IconText size={20} />,
  duplicate: <IconDuplicate size={20} />,
  pin: <IconPin size={20} />,
  front: <IconToFront size={20} />,
  back: <IconToBack size={20} />,
  download: <IconDownload size={20} />,
  archive: <IconArchive size={20} />,
  delete: <IconTrash size={20} />,
}

export function TabletInspector({
  store,
  items,
  modelName,
  onAction,
  onClose,
}: {
  store: CanvasStore
  items: CanvasItem[]
  modelName?: string
  onAction(action: InspectorAction, items: CanvasItem[]): void
  onClose(): void
}) {
  useContentVersion(store)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const many = items.length > 1
  const first = items[0]
  if (!first) return null

  const actions = many ? actionsForMany(items) : actionsForItem(first)
  const mutationBlockReason = ''
  const grouped = {
    edit: actions.filter((action) => actionSection(action) === 'edit'),
    arrange: actions.filter((action) => actionSection(action) === 'arrange'),
    file: actions.filter((action) => actionSection(action) === 'file'),
  }

  const renderActions = (title: string, values: InspectorAction[]) => values.length > 0 && (
    <section className="tablet-inspector-section" aria-label={title}>
      <p className="tablet-inspector-label">{title}</p>
        <div className="tablet-inspector-grid">
          {values.map((action) => {
            const disabled = false
            return (
              <button
                key={action}
                type="button"
                className="tablet-act"
                disabled={disabled}
                title={disabled ? mutationBlockReason : undefined}
                aria-label={disabled ? `${ACTION_LABEL[action]}. ${mutationBlockReason}` : undefined}
                onClick={() => onAction(action, items)}
              >
                {ICONS[action]}
                <span>{ACTION_LABEL[action]}</span>
              </button>
            )
          })}
      </div>
    </section>
  )

  return (
    <aside className="tablet-inspector" aria-label="Selected">
      <div className="tablet-inspector-head">
        <span className="tablet-inspector-thumb">
          {first.kind === 'image' && first.src
            ? <img src={previewSrc(first.src)} alt="" decoding="async" />
            : <span className="tablet-inspector-kind">{ICONS[first.kind === 'video' ? 'clip' : first.kind === 'audio' ? 'extract-audio' : 'edit-text']}</span>}
        </span>
        <div className="tablet-inspector-name">
          <h2>{many ? `Selected: ${items.length}` : subjectTitle(first)}</h2>
          <p>{many ? 'general actions' : subjectDetails(first, modelName)}</p>
        </div>
        <button type="button" className="ui-icon-btn" aria-label="Clear selection" onClick={onClose}>
          <IconClose size={18} />
        </button>
      </div>

      <div className="tablet-inspector-scroll">
        {renderActions('Edit', grouped.edit)}

        {many && actions.includes('compare') && (
          <p className="tablet-inspector-help">The first selected frame is the original; browse the others as variants.</p>
        )}

        {renderActions('Position', grouped.arrange)}
        {many && (
          <TabletArrangeControls
            store={store}
            ids={items.map((item) => item.id)}
            disabled={false}
            disabledReason={mutationBlockReason}
          />
        )}
        {renderActions('File', grouped.file)}
      </div>

      <div className="tablet-inspector-foot">
        <button
          type="button"
          className="ui-btn danger"
          disabled={false}
          title={false ? mutationBlockReason : undefined}
          onClick={() => {
            // Второе нажатие вместо системного вопроса: диалог на планшете
            // закрывает пол-экрана, а промахнуться пальцем легко.
            if (!confirmDelete) {
              setConfirmDelete(true)
              window.setTimeout(() => setConfirmDelete(false), 4000)
              return
            }
            onAction('delete', items)
          }}
        >
          <IconTrash size={18} /> {confirmDelete ? 'Delete for good?' : 'Delete'}
        </button>
      </div>
    </aside>
  )
}
