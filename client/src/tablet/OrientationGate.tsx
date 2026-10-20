import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconRotate } from '../ui/icons'
import { readOrientation, watchOrientation, type OrientationState } from './orientation'
import { useModalFocus } from './modalFocus'
import {
  dismissHomeScreenHint,
  homeScreenHintDismissed,
  isAppleTouchDevice,
  isStandalone,
  shouldShowHomeScreenHint,
} from './homeScreenHint'

// Ворота ландшафта и подсказка про домашний экран.
//
// Портретную раскладку мы не верстаем вовсе — иначе пришлось бы поддерживать
// вторую, ради отказа от которой всё и затевалось. В портрете человек видит
// одну карточку и ничего больше.

const TEXT: Record<Exclude<OrientationState, 'ok'>, { title: string; body: string }> = {
  rotate: {
    title: 'Rotate your tablet',
    body: 'CanAI works in landscape mode — the canvas needs room.',
  },
  widen: {
    title: 'Widen the window',
    body: 'The board needs more width than this half of the screen. Return CanAI to full screen or widen the window.',
  },
}

export function OrientationGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OrientationState>(() => readOrientation())

  useEffect(() => watchOrientation(setState), [])

  return (
    <>
      <div className="tablet-orientation-content">
        {children}
      </div>
      {state !== 'ok' && <OrientationBlock state={state} />}
      {state === 'ok' && <HomeScreenHint />}
    </>
  )
}

function OrientationBlock({ state }: { state: Exclude<OrientationState, 'ok'> }) {
  const ref = useRef<HTMLDivElement>(null)
  // This scope outranks editors, including portals that finish mounting while
  // the device is blocked. The shared manager restores their focus on return.
  useModalFocus(ref, undefined, 100)
  const text = TEXT[state]
  return createPortal(
    <div ref={ref} className="tablet-orientation" role="dialog" aria-modal="true" aria-label={text.title} tabIndex={-1}>
      <IconRotate size={64} className="tablet-orientation-icon" />
      <h1>{text.title}</h1>
      <p>{text.body}</p>
    </div>, document.body,
  )
}

function HomeScreenHint() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Считаем один раз при появлении: состояние «уже приложение» за сеанс не
    // меняется, а лишняя подписка — это лишний повод для перерисовки.
    setVisible(shouldShowHomeScreenHint({
      standalone: isStandalone(),
      dismissed: homeScreenHintDismissed(),
      appleTouch: isAppleTouchDevice(),
    }))
  }, [])

  if (!visible) return null
  return (
    <div className="tablet-home-hint" role="note">
      <div>
        <strong>Add CanAI to your home screen</strong>
        <p>Choose “Share” → “Add to Home Screen”. The tablet stays in landscape, the address bar disappears, and the board gets the full screen.</p>
      </div>
      <button
        type="button"
        className="ui-btn quiet"
        onClick={() => {
          dismissHomeScreenHint()
          setVisible(false)
        }}
      >
        Do not show again
      </button>
    </div>
  )
}
