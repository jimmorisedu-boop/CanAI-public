import { useEffect, useState } from 'react'
import { api, type FaceModelsResponse } from '../api'
import { faceModelsLicenses, faceModelsView, shouldPollFaceModels } from './faceModelsState'
import { systemErrorMessage } from '../ui/systemMessage'
import { useT } from '../i18n/context.js'


// Модели сравнения лиц в настройках: показать состояние и дать скачать.
// Опрос идёт ТОЛЬКО пока идёт закачка — постоянный тик ради строки, которая
// меняется раз в жизни, приложению не нужен.

const POLL_MS = 900

export function FaceModelsSection() {
  const t = useT()
  const [state, setState] = useState<FaceModelsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.faceModelsState()
      .then((next) => { if (!cancelled) setState(next) })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('Could not read model status'))
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!shouldPollFaceModels(state)) return
    let cancelled = false
    const timer = setTimeout(() => {
      api.faceModelsState()
        .then((next) => { if (!cancelled) setState(next) })
        // Обрыв опроса не гасит закачку: она идёт на сервере, состояние
        // подтянется при следующем открытии настроек.
        .catch(() => undefined)
    }, POLL_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [state])

  const view = faceModelsView(state)
  const licenses = faceModelsLicenses(state)

  function start(): void {
    setError(null)
    // Рисуем закачку сразу: иначе между нажатием и первым процентом кнопка
    // выглядит так, будто клик не засчитался.
    setState({ state: 'downloading', percent: 0, models: state?.models ?? [] })
    api.prepareFaceModels()
      .then(setState)
      .catch((cause: unknown) => {
        setState({
          state: 'failed',
          message: cause instanceof Error ? cause.message : t('Could not start download'),
          models: state?.models ?? [],
        })
      })
  }

  return (
    <section className="settings-section" aria-labelledby="face-models-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="face-models-title">{t('Face comparison')}</h3>
          <p>{t('Shows how similar a person is in the source and result in Compare.')}</p>
        </div>
        <span className="settings-connection" data-tone={view.tone} role="status">
          {view.label}
        </span>
      </div>
      {view.note && <p className="settings-note">{state?.state === 'failed'
        ? systemErrorMessage(view.note, 'Could not download models')
        : view.note}</p>}
      {licenses && <p className="settings-note">{t('Models:')} {licenses}.</p>}
      {view.action && (
        <div className="settings-editor-actions">
          <button type="button" className="editor-close" disabled={view.busy} onClick={start}>
            {view.action}
          </button>
        </div>
      )}
      {error && <p className="settings-note" role="status">{systemErrorMessage(error, 'Could not read model status')}</p>}
    </section>
  )
}
