import React from 'react'
import ReactDOM from 'react-dom/client'
import { TabletApp } from './TabletApp'
import { LanguageProvider } from '../i18n/context'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { ConfirmHost } from '../ui/ConfirmHost'
import { LiveRegion } from '../ui/LiveRegion'
import { IconProvider } from '../ui/icons'
import { installRemoteFetch } from './remoteSession'
import { installLogHandle } from '../diag/install'
import { log } from '../diag/log'
import { clientBuild, formatBuild } from '../diag/buildInfo'
import '../styles/tokens.css'
import '../styles/modal.css'
import '../styles/controls.css'
import '../styles/price-params.css'
import '../styles/notices.css'
import '../styles/diagnostics.css'
import '../styles/typography-motion.css'
import '../styles/focus.css'
import '../styles/media-playback.css'
import '../styles/agents.css'
import '../styles/agents-dock.css'
import '../styles/action-dock-batch.css'
import '../styles/help.css'
import './tablet.css'
import '../styles/tabletClipPreview.css'
import '../styles/tabletClipEditor.css'
import './tabletCompactChrome.css'
import './tabletCrop.css'
import './tabletPrompt.css'
import './tabletMediaViewer.css'
import './tabletResizeEditor.css'
import './tabletResize.css'
import { installNativeMediaErrorGuard } from '../ui/nativeMediaErrorGuard'

installNativeMediaErrorGuard()
// The tablet is a view of the local Host. Its request bridge is installed
// before React performs the first board or gallery request.
installRemoteFetch()
installLogHandle()
log.info('app', 'tablet page started', { build: formatBuild(clientBuild()) })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="tablet">
      <IconProvider>
        <LanguageProvider>
          <TabletApp />
          <ConfirmHost />
          <LiveRegion />
        </LanguageProvider>
      </IconProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
