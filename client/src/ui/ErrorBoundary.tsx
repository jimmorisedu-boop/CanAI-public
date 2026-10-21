import { Component, type ReactNode } from 'react'
import { t } from '../i18n/translate.js'

// Предохранитель интерфейса: ошибка отрисовки внутри не кладёт всё приложение
// белым экраном. Классовый компонент — у хуков нет аналога componentDidCatch.
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[CanAI] interface error:', error)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const where = this.props.label ? ` in “${this.props.label}”` : ''
    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-card">
          <h2>{t('The interface stopped working{0}', { 0: where })}</h2>
          <p>{t('Your data is safe: boards are saved to disk, not the browser. Reloading the page usually helps.')}</p>
          <button className="error-boundary-reload" onClick={() => window.location.reload()}>
            {t('Reload')}
          </button>
          <details>
            <summary>{t('Technical details')}</summary>
            <pre>{String(this.state.error.stack ?? this.state.error)}</pre>
          </details>
        </div>
      </div>
    )
  }
}
