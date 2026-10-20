import { useEffect, useState } from 'react'
import { InlineNotice } from '../ui/InlineNotice'
import { GlobalNotifications } from '../ui/GlobalNotifications'
import { deviceName } from '../spaces/canvas/continuity/deviceIdentity'
import { OrientationGate } from './OrientationGate'
import { TabletBoard } from './TabletBoard'
import { TabletGallery } from './TabletGallery'
import { applyTheme, readTheme } from './tabletTheme'
import { readRemoteSession, remoteLogin, type RemoteSessionState } from './remoteSession'
import { LanTabletRuntime } from './lanRuntime'
import type { TabletProject, TabletRuntime } from './runtime'
import { useTabletUiScale } from './useTabletUiScale'
import { tabletSystemMessage } from './tabletSystemMessage'

type Screen = { kind: 'gallery' } | { kind: 'board'; project: TabletProject }

const runtime: TabletRuntime = new LanTabletRuntime()

function LoginScreen({ onDone }: { onDone(state: RemoteSessionState): void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await remoteLogin(pin))
    } catch (err) {
      setError(tabletSystemMessage(err, 'Could not sign in'))
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tablet-login">
      <div className="tablet-login-card">
        <h1>CanAI</h1>
        <p>Enter the access code from your computer — Settings → Tablet access.</p>
        <input
          className="ui-field tablet-pin"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          value={pin}
          placeholder="Code"
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
          onKeyDown={(event) => { if (event.key === 'Enter' && pin.length >= 4) void submit() }}
        />
        {error && <InlineNotice className="tablet-error" tone="error" title={tabletSystemMessage(error, 'Could not sign in')} />}
        <button type="button" className="ui-btn primary" disabled={busy || pin.length < 4} onClick={() => void submit()}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <p className="tablet-login-note">This device: {deviceName()}</p>
      </div>
    </div>
  )
}

const CONNECT_TIMEOUT_MS = 12_000

export function TabletApp() {
  useTabletUiScale()
  const [session, setSession] = useState<RemoteSessionState | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [screen, setScreen] = useState<Screen>({ kind: 'gallery' })

  useEffect(() => {
    let done = false
    setUnreachable(false)
    const timer = globalThis.setTimeout(() => { if (!done) setUnreachable(true) }, CONNECT_TIMEOUT_MS)
    void readRemoteSession()
      .then((restored) => {
        done = true
        globalThis.clearTimeout(timer)
        setSession(restored)
      })
      .catch(() => {
        done = true
        globalThis.clearTimeout(timer)
        setUnreachable(true)
      })
    applyTheme(readTheme())
    return () => globalThis.clearTimeout(timer)
  }, [attempt])

  return (
    <OrientationGate>
      <Screens
        session={session}
        unreachable={unreachable}
        onRetry={() => setAttempt((value) => value + 1)}
        screen={screen}
        setSession={setSession}
        setScreen={setScreen}
      />
      <GlobalNotifications />
    </OrientationGate>
  )
}

function Screens({
  session,
  unreachable,
  onRetry,
  screen,
  setSession,
  setScreen,
}: {
  session: RemoteSessionState | null
  unreachable: boolean
  onRetry(): void
  screen: Screen
  setSession(state: RemoteSessionState): void
  setScreen(screen: Screen): void
}) {
  if (!session) {
    if (!unreachable) return <p className="tablet-state">Connecting…</p>
    return (
      <div className="tablet-login">
        <div className="tablet-login-card">
          <h1>Server is not responding</h1>
          <p>Could not reach the local CanAI app. Check the tablet connection and try again.</p>
          <button type="button" className="ui-btn primary" onClick={onRetry}>Try again</button>
        </div>
      </div>
    )
  }
  if (!session.authorized) {
    return session.pinSet
      ? <LoginScreen onDone={setSession} />
      : (
        <div className="tablet-login">
          <div className="tablet-login-card">
            <h1>CanAI</h1>
            <p>Tablet access is not set up yet. On your computer, open Settings → Tablet access, set a code, and enable access.</p>
            <button type="button" className="ui-btn" onClick={() => void readRemoteSession().then(setSession)}>Check again</button>
          </div>
        </div>
      )
  }
  if (screen.kind === 'board') {
    return (
      <TabletBoard
        key={screen.project.id}
        projectId={screen.project.id}
        boardName={screen.project.name}
        runtime={runtime}
        canEdit={screen.project.permissions.canEdit}
        canManage={screen.project.permissions.canManage}
        onExit={() => setScreen({ kind: 'gallery' })}
        onOpenProject={(project) => setScreen({ kind: 'board', project })}
        onRenamed={(name) => setScreen({ kind: 'board', project: { ...screen.project, name } })}
      />
    )
  }
  return (
    <TabletGallery
      runtime={runtime}
      canCreate
      onOpen={(project) => setScreen({ kind: 'board', project })}
    />
  )
}
