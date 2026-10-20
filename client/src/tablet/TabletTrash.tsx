import { useEffect, useState } from 'react'
import { api } from '../api'
import type { TrashedProjectMeta } from '../api'
import { IconRestore, IconTrash } from '../ui/icons'
import { notify } from '../spaces/canvas/notifications'
import { plural } from '../ui/plural'
import { previewSrc } from './remoteSession'
import { tabletSystemMessage } from './tabletSystemMessage'

// Корзина досок.
//
// Срока жизни у неё нет намеренно: восстановление должно работать и через
// месяц. Но ссылки из корзины держат медиа, поэтому чистить её надо — и делать
// это по одной доске, когда их шесть десятков, работа на час.
//
// Необратимое здесь есть, и защищает от промаха не запрет, а ВТОРОЕ нажатие:
// планшет — рабочее место, а не пульт.

export function TabletTrash() {
  const [boards, setBoards] = useState<TrashedProjectMeta[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const load = () => {
    void api.listProjectTrash().then((result) => setBoards(result.projects)).catch(() => {})
  }
  useEffect(load, [])

  if (boards.length === 0) {
    return <p className="tablet-state">Trash is empty.</p>
  }

  return (
    <div className="tablet-trash">
      <div className="tablet-trash-head">
        <span className="tablet-mono">
          {boards.length} {plural(boards.length, ['board', 'boards', 'boards'])}
        </span>
        <span className="tablet-full-gap" />
        <button
          type="button"
          className="ui-btn danger"
          disabled={busy}
          onClick={() => {
            if (!confirmAll) {
              setConfirmAll(true)
              window.setTimeout(() => setConfirmAll(false), 4000)
              return
            }
            setBusy(true)
            void api.emptyProjectTrash()
              .then((result) => {
                notify({ kind: 'success', message: `Boards deleted: ${result.deleted}` })
                setBoards([])
              })
              .catch((error: unknown) => {
                notify({ kind: 'error', message: tabletSystemMessage(error, 'Could not clear') })
              })
              .finally(() => {
                setBusy(false)
                setConfirmAll(false)
              })
          }}
        >
          {confirmAll ? 'Empty all trash?' : 'Empty trash'}
        </button>
      </div>

      <div className="tablet-trash-list">
        {boards.map((board) => (
          <div className="tablet-trash-row" key={board.id}>
            <span className="tablet-trash-thumb">
              {board.preview?.src
                ? <img src={previewSrc(board.preview.src)} alt="" decoding="async" onError={(event) => { (event.target as HTMLImageElement).style.visibility = 'hidden' }} />
                : <span className="tablet-trash-blank" />}
            </span>
            <div className="tablet-trash-name">
              <strong>{board.name}</strong>
              <span className="tablet-mono">
                {board.itemCount ?? 0} {plural(board.itemCount ?? 0, ['object', 'objects', 'objects'])}
              </span>
            </div>
            <button
              type="button"
              className="ui-btn"
              onClick={() => {
                void api.restoreTrashedProject(board.id)
                  .then(() => {
                    notify({ kind: 'success', message: `Board “${board.name}” restored` })
                    load()
                  })
                  .catch((error: unknown) => {
                    notify({ kind: 'error', message: tabletSystemMessage(error, 'Could not restore') })
                  })
              }}
            >
              <IconRestore size={18} /> Restore
            </button>
            <button
              type="button"
              className="ui-btn danger"
              onClick={() => {
                if (confirmId !== board.id) {
                  setConfirmId(board.id)
                  window.setTimeout(() => setConfirmId((current) => (current === board.id ? null : current)), 4000)
                  return
                }
                void api.deleteTrashedProject(board.id)
                  .then(() => {
                    notify({ kind: 'success', message: 'Deleted permanently' })
                    setConfirmId(null)
                    load()
                  })
                  .catch((error: unknown) => {
                    notify({ kind: 'error', message: tabletSystemMessage(error, 'Could not delete') })
                  })
              }}
            >
              <IconTrash size={18} /> {confirmId === board.id ? 'Are you sure?' : 'Delete'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
