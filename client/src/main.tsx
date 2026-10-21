import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { LanguageProvider } from './i18n/context'
import './styles.css'
import { ConfirmHost } from './ui/ConfirmHost'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { LiveRegion } from './ui/LiveRegion'
import { OfflineBanner } from './ui/OfflineBanner'
import { IconProvider } from './ui/icons'
import { installLogHandle } from './diag/install'
import { log } from './diag/log'
import { clientBuild, formatBuild } from './diag/buildInfo'
import { installNativeMediaErrorGuard } from './ui/nativeMediaErrorGuard'

installNativeMediaErrorGuard()
installLogHandle()
log.info('app', 'application started', { path: window.location.pathname, build: formatBuild(clientBuild()) })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <IconProvider>
        <LanguageProvider>
          <App />
          {/* окно подтверждения — одно на всё приложение и вне веток App:
              вопрос могут задать из любого экрана, включая галерею */}
          <ConfirmHost />
          {/* состояние связи — тоже общее: без интернета отваливаются только
              вызовы fal, а доски и холст работают, и сказать это надо один раз */}
          <OfflineBanner />
          {/* область объявлений для экранного диктора: результат генерации
              появляется на холсте молча, и без неё о нём никто не сообщает */}
          <LiveRegion />
        </LanguageProvider>
      </IconProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
