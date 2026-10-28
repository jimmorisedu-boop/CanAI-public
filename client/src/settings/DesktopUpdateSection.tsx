import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DesktopUpdateStatus } from '../../../packages/desktop-updates/protocol'
import { InlineNotice } from '../ui/InlineNotice'
import { useT, type Translate } from '../i18n/context.js'
import {
  desktopUpdateController,
  type DesktopUpdateController,
} from './desktopUpdateController'
import { runDesktopUpdateGuards, type DesktopUpdateGuardResult } from './desktopUpdateGuards'

export interface DesktopUpdateSectionProps {
  /** Dependency injection keeps SSR and transport tests deterministic. */
  controller?: DesktopUpdateController
  /** Test hook; production reloads the current page once after apply. */
  reload?(): void
  /** Persist the open Settings form before the prepared release is applied. */
  beforeRestart?(): Promise<DesktopUpdateGuardResult>
}

function clampPercent(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

function shortCommit(commit: string | null | undefined): string | null {
  const value = commit?.trim()
  return value ? value.slice(0, 8) : null
}

function releaseDetails(
  release: { commit: string | null; date: string | null },
  translate: Translate,
): string {
  const details: string[] = []
  const commit = shortCommit(release.commit)
  if (commit) details.push(translate('Build {0}', { 0: commit }))
  if (release.date) details.push(translate('Released {0}', { 0: release.date.slice(0, 10) }))
  return details.length > 0 ? ` · ${details.join(' · ')}` : ''
}

function currentLine(status: DesktopUpdateStatus, translate: Translate): string {
  const version = status.current.version || translate('Unknown')
  return `${translate('Current version: {0}', { 0: version })}${releaseDetails(status.current, translate)}`
}

function latestLine(
  release: NonNullable<DesktopUpdateStatus['latest']>,
  translate: Translate,
): string {
  return `${translate('New version {0}', { 0: release.version })}${releaseDetails(release, translate)}`
}

const DESKTOP_UPDATE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'no-release': 'No trusted release is available yet. Check again later.',
  'dirty-tree': 'Save your local changes, then try again.',
  'wrong-origin': 'Use the CanAI source for this copy, then try again.',
  'wrong-branch': 'Switch to the CanAI main branch, then try again.',
  'checksum-mismatch': 'The downloaded release could not be verified. Try again later.',
  'update-interrupted': 'The update was interrupted. Try again from Settings; recovery data was kept.',
  'rollback-failed': 'The update failed and automatic recovery did not finish. Keep this copy and contact support.',
}

/** Translate updater failures into short actions without exposing feed details. */
export function desktopUpdateErrorMessage(
  source: Pick<DesktopUpdateStatus, 'code' | 'message'>,
  translate: Translate,
): string {
  const key = source.code ? DESKTOP_UPDATE_ERROR_MESSAGES[source.code] : undefined
  return key ? translate(key) : source.message?.trim() || translate('The update could not be completed.')
}

/** Keep the pre-apply decision testable without mounting the Settings modal. */
export async function runDesktopUpdateBeforeRestart(
  beforeRestart?: () => Promise<DesktopUpdateGuardResult>,
): Promise<DesktopUpdateGuardResult> {
  if (!beforeRestart) return { ok: true }
  try {
    return await beforeRestart()
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not save settings before updating.',
    }
  }
}

export function DesktopUpdateSection({
  controller = desktopUpdateController,
  reload,
  beforeRestart,
}: DesktopUpdateSectionProps) {
  const t = useT()
  // React invokes external-store callbacks without a receiver. Keep wrappers
  // stable so class-based controllers retain `this` and subscriptions do not
  // churn on every status update.
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller])
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [actionError, setActionError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const alive = useRef(true)
  const lifecycle = useRef(0)
  const reloadScheduled = useRef(false)

  useEffect(() => {
    alive.current = true
    const generation = ++lifecycle.current
    void controller.load().catch(() => {})
    return () => {
      alive.current = false
      // A preparation may continue in the singleton controller after Settings
      // closes, but an old click must never apply it after a later remount.
      if (lifecycle.current === generation) lifecycle.current += 1
    }
  }, [controller])

  const reloadOnce = useCallback((jobId: string) => {
    if (reloadScheduled.current || typeof window === 'undefined') return
    const marker = `canai-desktop-update-reloaded:${jobId}`
    try {
      if (window.sessionStorage.getItem(marker)) return
      window.sessionStorage.setItem(marker, '1')
    } catch {
      // A private browsing context may not expose sessionStorage. The ref still
      // prevents duplicate reloads during this render lifetime.
    }
    reloadScheduled.current = true
    if (reload) reload()
    else window.location.reload()
  }, [reload])

  const runAction = useCallback(async () => {
    if (working || !alive.current) return
    const generation = lifecycle.current
    const isCurrent = () => alive.current && lifecycle.current === generation
    setActionError(null)
    setWorking(true)
    try {
      let next = controller.getSnapshot()
      if (!next || next.phase === 'idle' || next.phase === 'up-to-date' || next.phase === 'error') {
        next = await controller.check()
      }
      if (next.phase === 'available') {
        const target = next.latest?.target
        if (!target) {
          setActionError(t('The update service did not provide a release target.'))
          return
        }
        next = await controller.prepare(target)
      }
      if (!isCurrent()) return
      if (next.phase !== 'ready') {
        if (next.phase === 'error') setActionError(desktopUpdateErrorMessage(next, t))
        return
      }
      if (!next.jobId) {
        setActionError(t('The update is ready, but its job could not be found.'))
        return
      }
      const guard = await runDesktopUpdateGuards()
      if (!isCurrent()) return
      if (!guard.ok) {
        setActionError(guard.message)
        return
      }
      const persisted = await runDesktopUpdateBeforeRestart(beforeRestart)
      if (!isCurrent()) return
      if (!persisted.ok) {
        setActionError(persisted.message)
        return
      }
      if (!isCurrent()) return
      const beforeVersion = next.current.version
      const applied = await controller.apply(next.jobId)
      if (!isCurrent()) return
      if (applied.phase === 'complete' || applied.current.version !== beforeVersion) {
        reloadOnce(next.jobId)
      } else if (applied.phase === 'error') {
        setActionError(desktopUpdateErrorMessage(applied, t))
      }
    } catch (error) {
      if (!isCurrent()) return
      setActionError(error instanceof Error ? error.message : t('Could not update the app.'))
    } finally {
      if (isCurrent()) setWorking(false)
    }
  }, [beforeRestart, controller, reloadOnce, t, working])

  if (!status) {
    return (
      <section className="settings-section desktop-update-section" aria-labelledby="desktop-update-title">
        <div className="settings-section-heading">
          <div>
            <h3 id="desktop-update-title">{t('App updates')}</h3>
            <p>{t('Check for a verified CanAI release and update this desktop app.')}</p>
          </div>
        </div>
        <p className="settings-note" role="status">{t('Checking for updates…')}</p>
      </section>
    )
  }

  const percent = clampPercent(status.progress?.percent)
  const busy = working || status.phase === 'checking' || status.phase === 'preparing' || status.phase === 'restarting'
  const buttonLabel = status.phase === 'available' || status.phase === 'ready'
    ? t('Update')
    : status.phase === 'checking' || status.phase === 'preparing'
      ? t('Checking…')
      : status.phase === 'restarting'
        ? t('Restarting…')
        : status.phase === 'error'
          ? t('Try again')
          : t('Check for updates')
  const showLatest = Boolean(status.latest && (
    status.phase === 'available' ||
    status.phase === 'preparing' ||
    status.phase === 'ready' ||
    status.phase === 'restarting' ||
    status.phase === 'complete'
  ))
  const activeButtonLabel = working
    ? (status.phase === 'preparing' || status.phase === 'ready' || status.phase === 'restarting'
      ? t('Saving and updating…')
      : t('Checking for updates…'))
    : buttonLabel

  return (
    <section className="settings-section desktop-update-section" aria-labelledby="desktop-update-title">
      <div className="settings-section-heading">
        <div>
          <h3 id="desktop-update-title">{t('App updates')}</h3>
          <p>{t('Check for a verified CanAI release and update this desktop app.')}</p>
        </div>
        <span className="settings-connection" data-tone={status.phase === 'up-to-date' ? 'success' : status.phase === 'error' ? 'warning' : undefined} role="status">
          {currentLine(status, t)}
        </span>
      </div>

      <div className="settings-account-card desktop-update-card">
        <strong>
          {status.phase === 'unsupported'
            ? t('Updates are not supported on this platform.')
            : status.phase === 'up-to-date'
              ? t('You’re up to date.')
              : status.phase === 'checking'
                ? t('Checking for updates…')
              : status.phase === 'available'
                ? t('New version {0} is available.', { 0: status.latest?.version ?? t('unknown') })
                : status.phase === 'preparing'
                  ? t('Preparing the update…')
                  : status.phase === 'ready'
                    ? t('The update is ready to install.')
                    : status.phase === 'restarting'
                      ? t('Restarting CanAI…')
                      : status.phase === 'complete'
                        ? t('Update complete.')
                        : status.phase === 'error'
                          ? t('The update could not be completed.')
                        : status.message ?? t('Check for a new release when you are ready.')}
        </strong>
        {showLatest && status.latest && (
          <>
            <p>{latestLine(status.latest, t)}</p>
            {status.latest.notes.length > 0 && (
              <ul className="desktop-update-notes">
                {status.latest.notes.map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}
              </ul>
            )}
          </>
        )}
        {status.progress && (status.phase === 'preparing' || status.phase === 'restarting') && (
          <div className="desktop-update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} {...(percent == null ? {} : { 'aria-valuenow': percent })}>
            <span style={percent == null ? undefined : { width: `${percent}%` }} />
            <small>{status.progress.detail ?? status.progress.stage}</small>
          </div>
        )}
      </div>

      {(actionError || status.phase === 'error') && (
        <InlineNotice
          tone="error"
          title={actionError ?? desktopUpdateErrorMessage(status, t)}
          system={false}
          onDismiss={() => setActionError(null)}
        />
      )}
      {status.phase === 'unsupported' ? (
        <p className="settings-note">{t('Use the supported desktop build to update CanAI.')}</p>
      ) : (
        <div className="settings-team-actions">
          <button type="button" className="ui-btn primary" disabled={busy} onClick={() => void runAction()}>
            {activeButtonLabel}
          </button>
        </div>
      )}
    </section>
  )
}
