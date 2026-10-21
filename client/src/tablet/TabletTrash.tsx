import { useEffect, useState } from 'react'
import { api } from '../api'
import type { TrashedProjectMeta } from '../api'
import { IconRestore, IconTrash } from '../ui/icons'
import { notify } from '../spaces/canvas/notifications'
import { previewSrc } from './remoteSession'
import { tabletSystemMessage } from './tabletSystemMessage'
import { useT } from '../i18n/context.js'


// Корзина досок.
//
// Срока жизни у неё нет намеренно: восстановление должно работать и через
// месяц. Но ссылки из корзины держат медиа, поэтому чистить её надо — и делать
// это по одной доске, когда их шесть десятков, работа на час.
//
// Необратимое здесь есть, и защищает от промаха не запрет, а ВТОРОЕ нажатие:
// планшет — рабочее место, а не пульт.

export function TabletTrash() {
  const t = useT()
  const [boards, setBoards] = useState<TrashedProjectMeta[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const load = () => {
    void api.listProjectTrash().then((result) => setBoards(result.projects)).catch(() => {})
  }
  useEffect(load, [])

  if (boards.length === 0) {
    return <p className="tablet-state">{t('Trash is empty.')}</p>
  }

  return (
    <div className="tablet-trash">
      <div className="tablet-trash-head">
        <span className="tablet-mono">
          {boards.length} {t(Math.abs(boards.length) === 1 ? 'board' : 'boards')}
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
                notify({ kind: 'success', message: t('Boards deleted: {0}', { 0: result.deleted }) })
                setBoards([])
              })
              .catch((error: unknown) => {
                notify({ kind: 'error', message: tabletSystemMessage(error, t('Could not clear')) })
              })
              .finally(() => {
                setBusy(false)
                setConfirmAll(false)
              })
          }}
        >
          {confirmAll ? t('Empty all trash?') : t('Empty trash')}
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
                {board.itemCount ?? 0} {t(Math.abs(board.itemCount ?? 0) === 1 ? 'object' : 'objects')}
              </span>
            </div>
            <button
              type="button"
              className="ui-btn"
              onClick={() => {
                void api.restoreTrashedProject(board.id)
                  .then(() => {
                    notify({ kind: 'success', message: t('Board “{0}” restored', { 0: board.name }) })
                    load()
                  })
                  .catch((error: unknown) => {
                    notify({ kind: 'error', message: tabletSystemMessage(error, t('Could not restore')) })
                  })
              }}
            >
              <IconRestore size={18} />  {t('Restore')}
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
                    notify({ kind: 'success', message: t('Deleted permanently') })
                    setConfirmId(null)
                    load()
                  })
                  .catch((error: unknown) => {
                    notify({ kind: 'error', message: tabletSystemMessage(error, t('Could not delete')) })
                  })
              }}
            >
              <IconTrash size={18} /> {confirmId === board.id ? t('Are you sure?') : t('Delete')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
