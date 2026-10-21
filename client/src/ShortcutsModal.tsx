import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { HelpPanel } from './help/HelpPanel'
import { useDialogFocus } from './ui/dialogFocus'
import { HOTKEY_GROUPS, formatHotkeyKeys, hotkeysOfGroup } from './ui/hotkeys'
import { requestOnboardingTarget } from './spaces/canvas/onboardingEvents'
import { type OnboardingDocument } from './spaces/canvas/onboardingModel'
import { onboardingStore, useOnboardingSnapshot, type OnboardingSnapshot } from './spaces/canvas/onboardingStore'
import { createHelpCardTarget, createRecoveryTarget, showOnboardingTarget } from './spaces/canvas/onboardingTargets'
import { openSettings } from './settings/settingsBus'
import { useT } from './i18n'

export function OnboardingHelpSection({
  status,
  document,
  editorMounted,
  onShow,
}: {
  status: OnboardingSnapshot['status']
  document: OnboardingDocument | null
  editorMounted: boolean
  onShow(): void
  /** Kept for legacy consumers; reopening now owns the reset operation. */
  onReset?(): void
}) {
  const t = useT()
  const canShow = editorMounted && status === 'ready' && document !== null
  return (
    <section id="onboarding-recovery" className="shortcuts-group onboarding-help" aria-labelledby="onboarding-help-title">
      <h3 id="onboarding-help-title">{t('First steps')}</h3>
      <p>{t('A short, optional tour of the board.')}</p>
      <div className="onboarding-actions">
        {canShow && <button className="onboarding-help-action" type="button" onClick={onShow}>{t('Open first steps')}</button>}
      </div>
    </section>
  )
}

type HelpTab = 'guides' | 'shortcuts'
const HELP_TABS: HelpTab[] = ['guides', 'shortcuts']

// This is the application's Help shell. The Guides tab is deliberately the
// default; keeping shortcuts here preserves the existing `?` entry point and
// the recovery target used by canvas actions.
export function ShortcutsModal({
  onClose,
  editorMounted = false,
  recoveryTargetRequest = 0,
  initialTopicId,
}: {
  onClose: () => void
  editorMounted?: boolean
  recoveryTargetRequest?: number
  initialTopicId?: string
}) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  const undoRowRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<Record<HelpTab, HTMLButtonElement | null>>({ guides: null, shortcuts: null })
  const [tab, setTab] = useState<HelpTab>('guides')
  const { status, document } = useOnboardingSnapshot()
  useDialogFocus(dialogRef, onClose)
  const revealRecovery = useCallback(createRecoveryTarget({
    pulseUndoRow: () => showOnboardingTarget(undoRowRef.current, {
      message: t('Ctrl+Z undoes the last action. Board versions are available in the project menu.'),
    }),
    focusModalAction: () => closeButtonRef.current?.focus({ preventScroll: true }),
  }), [t])

  const showHelpTarget = useCallback((topic: { target?: string }): boolean => {
    if (topic.target !== 'recovery') return false
    setTab('shortcuts')
    window.requestAnimationFrame(revealRecovery)
    return true
  }, [revealRecovery])

  const focusTab = (next: HelpTab): void => {
    setTab(next)
    window.requestAnimationFrame(() => tabRefs.current[next]?.focus())
  }

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = HELP_TABS.indexOf(tab)
    let next = current
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % HELP_TABS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + HELP_TABS.length) % HELP_TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = HELP_TABS.length - 1
    else return
    event.preventDefault()
    focusTab(HELP_TABS[next])
  }

  useEffect(() => {
    if (recoveryTargetRequest === 0) return
    setTab('shortcuts')
    window.requestAnimationFrame(revealRecovery)
  }, [recoveryTargetRequest, revealRecovery])

  const showCardFromHelp = useCallback(createHelpCardTarget({
    closeHelp: onClose,
    defer: (run) => window.requestAnimationFrame(run),
    requestCard: () => requestOnboardingTarget('card'),
  }), [onClose])

  const reopenTutorial = useCallback(() => {
    // A completed legacy checklist must not block the new optional tour. Reset
    // is the existing server-backed action, so reopening stays durable without
    // inventing a second onboarding schema or localStorage flag.
    void onboardingStore.reset().then(showCardFromHelp)
  }, [showCardFromHelp])

  return (
    <div className="settings-backdrop help-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="settings-modal shortcuts-modal help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header help-header">
          <div>
            <p className="help-eyebrow">CanAI</p>
            <h2 id="help-title">{t('Help')}</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="settings-close help-close" onClick={onClose} aria-label={t('Close help')}>
            ×
          </button>
        </header>
        <div className="help-tabs" role="tablist" aria-label={t('Help sections')} aria-orientation="horizontal">
          <button
            id="help-tab-guides"
            type="button"
            role="tab"
            aria-controls="help-panel-guides"
            aria-selected={tab === 'guides'}
            tabIndex={tab === 'guides' ? 0 : -1}
            ref={(element) => { tabRefs.current.guides = element }}
            className={tab === 'guides' ? 'active' : ''}
            onKeyDown={onTabKeyDown}
            onClick={() => setTab('guides')}
          >
            {t('Guides')}
          </button>
          <button
            id="help-tab-shortcuts"
            type="button"
            role="tab"
            aria-label={t('Keyboard shortcuts')}
            aria-controls="help-panel-shortcuts"
            aria-selected={tab === 'shortcuts'}
            tabIndex={tab === 'shortcuts' ? 0 : -1}
            ref={(element) => { tabRefs.current.shortcuts = element }}
            className={tab === 'shortcuts' ? 'active' : ''}
            onKeyDown={onTabKeyDown}
            onClick={() => setTab('shortcuts')}
          >
            {t('Shortcuts')}
          </button>
        </div>
        <div
          id="help-panel-guides"
          role="tabpanel"
          aria-labelledby="help-tab-guides"
          tabIndex={0}
          hidden={tab !== 'guides'}
          className="help-content"
        >
          <HelpPanel
            initialTopicId={initialTopicId}
            onClose={onClose}
            onShowTutorial={editorMounted ? reopenTutorial : undefined}
            onShowTarget={showHelpTarget}
            showBoardActions={editorMounted}
          />
        </div>
        <div
          id="help-panel-shortcuts"
          role="tabpanel"
          aria-labelledby="help-tab-shortcuts"
          tabIndex={0}
          hidden={tab !== 'shortcuts'}
          className="shortcuts-content help-shortcuts-content"
        >
          <div className="shortcuts-grid">
            {HOTKEY_GROUPS.map((group) => (
              <div key={group.id} className="shortcuts-group">
                <h3>{t(group.title)}</h3>
                {hotkeysOfGroup(group.id).map((item) => (
                  <div
                    key={item.id}
                    ref={item.id === 'canvas.undo' ? undoRowRef : undefined}
                    className="shortcuts-row"
                  >
                    <span className="shortcuts-keys">{t(formatHotkeyKeys(item.keys))}</span>
                    <span className="shortcuts-what">{t(item.what)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <OnboardingHelpSection
            status={status}
            document={document}
            editorMounted={editorMounted}
            onShow={reopenTutorial}
          />
        </div>
        <div className="settings-actions help-actions">
          <button
            type="button"
            className="ui-btn quiet"
            onClick={() => { onClose(); openSettings(undefined, 'diagnostics') }}
          >
            {t('Report a problem')}
          </button>
          <button className="editor-close" onClick={onClose}>{t('Close (Esc)')}</button>
        </div>
      </div>
    </div>
  )
}
