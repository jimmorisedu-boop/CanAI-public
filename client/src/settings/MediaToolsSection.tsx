import { useEffect, useState } from 'react'
import { api } from '../api'
import { mediaToolsView, shouldPollMediaTools, type FfmpegStateResponse } from './mediaToolsState'
import { systemErrorMessage } from '../ui/systemMessage'
import { useT } from '../i18n/context.js'


// Компонент обработки видео в настройках: показать состояние и дать скачать.
// Опрос идёт ТОЛЬКО пока состояние — «качается»: постоянный тик ради строчки,
// которая меняется раз в жизни, приложению не нужен.

const POLL_MS = 900

export function MediaToolsSection() {
  const t = useT()
  const [state, setState] = useState<FfmpegStateResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.ffmpegState()
      .then((next) => { if (!cancelled) setState(next) })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('Could not read component status'))
      })
    return () => { cancelled = true }
  }, [])

  // Эффект перезапускается на каждое новое состояние и сам себя останавливает,
  // когда закачка кончилась, — отдельного цикла с таймерами держать не нужно.
  useEffect(() => {
    if (!shouldPollMediaTools(state)) return
    let cancelled = false
    const timer = setTimeout(() => {
      api.ffmpegState()
        .then((next) => { if (!cancelled) setState(next) })
        // Обрыв опроса не гасит саму закачку: она идёт на сервере, состояние
        // подтянется при следующем открытии настроек.
        .catch(() => undefined)
    }, POLL_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [state])

  const view = mediaToolsView(state)

  function start(): void {
    setError(null)
    // Рисуем закачку сразу, не дожидаясь ответа: иначе между нажатием и первым
    // процентом кнопка выглядит так, будто клик не засчитался.
    setState({ state: 'downloading', percent: 0 })
    api.prepareFfmpeg()
      .then(setState)
      .catch((cause: unknown) => {
        setState({ state: 'failed', message: cause instanceof Error ? cause.message : t('Could not start download') })
      })
  }

  return (
    <section className="settings-section" aria-labelledby="media-tools-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="media-tools-title">{t('Video and audio processing')}</h3>
          <p>{t('Trim, split into shots, extract audio tracks and frames.')}</p>
        </div>
        <span className="settings-connection" data-tone={view.tone} role="status">
          {view.label}
        </span>
      </div>
      {view.note && <p className="settings-note">{state?.state === 'failed'
        ? systemErrorMessage(view.note, 'Could not download component')
        : view.note}</p>}
      {view.action && (
        <div className="settings-editor-actions">
          <button type="button" className="editor-close" disabled={view.busy} onClick={start}>
            {view.action}
          </button>
        </div>
      )}
      {error && <p className="settings-note" role="status">{systemErrorMessage(error, 'Could not read component status')}</p>}
    </section>
  )
}
