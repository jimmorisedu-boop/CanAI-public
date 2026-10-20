import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  IconCopy,
  IconCursor,
  IconEyeOff,
  IconFit,
  IconFitAll,
  IconMouse,
  IconRedo,
  IconTouchpad,
  IconUndo,
} from '../ui/icons'
import { HelpPanel } from '../help/HelpPanel'
import { TabletFullScreen } from './TabletFullScreen'

export const TABLET_GESTURES: Array<{ icon: ReactNode; title: string; note: string }> = [
  { icon: <IconCursor size={22} />, title: 'Select', note: 'Tap an object. The “Select” button in the header enables multi-select.' },
  { icon: <IconCursor size={22} />, title: 'Marquee select', note: 'Hold an empty area and drag. With a stylus you can draw a marquee immediately; hold a finger with the stylus to start one over an object.' },
  { icon: <IconTouchpad size={22} />, title: 'Prompt panel', note: 'Drag the handle above the panel to move it. The − and + buttons change width; ↔ lets you drag the edge. “Return to bottom” resets position and width.' },
  { icon: <IconFit size={22} />, title: 'Interface size', note: 'Open “More” and choose “Smaller interface” or “Larger interface”. You can also pinch the panels.' },
  { icon: <IconTouchpad size={22} />, title: 'Move around the canvas', note: 'Drag an empty area with one finger. Pinch with two fingers to zoom and pan without changing card size.' },
  { icon: <IconFit size={22} />, title: 'Open large', note: 'Quickly double-tap a finished image or video. The same action is available with “Open large” in the object panel.' },
  { icon: <IconFitAll size={22} />, title: 'Resize', note: 'Select an object and choose “Resize”. Enter width and height, then press “Apply” — this changes the canvas card in one history step.' },
  { icon: <IconMouse size={22} />, title: 'Object menu', note: 'Hold an object to open actions beside it.' },
  { icon: <IconUndo size={22} />, title: 'Undo', note: 'Tap with two fingers or swipe left with three. Hold two fingers to undo repeatedly.' },
  { icon: <IconRedo size={22} />, title: 'Redo', note: 'Tap with three fingers or swipe right with three. Hold three fingers to redo repeatedly.' },
  { icon: <IconCopy size={22} />, title: 'Copy and paste', note: 'Swipe down with three fingers — the menu appears where your fingers were. Paste places objects at that point.' },
  { icon: <IconEyeOff size={22} />, title: 'Hide interface', note: 'Tap with four fingers to hide and restore the panels.' },
  { icon: <IconFitAll size={22} />, title: 'Show all', note: 'Open “More” and choose “Show all” or “1:1”.' },
]

type TabletHelpTab = 'guides' | 'gestures'
const TABLET_HELP_TABS: TabletHelpTab[] = ['guides', 'gestures']

export function TabletHelp({ onClose }: { onClose(): void }) {
  const [tab, setTab] = useState<TabletHelpTab>('guides')
  const tabRefs = useRef<Record<TabletHelpTab, HTMLButtonElement | null>>({ guides: null, gestures: null })
  const focusTab = (next: TabletHelpTab): void => {
    setTab(next)
    window.requestAnimationFrame(() => tabRefs.current[next]?.focus())
  }
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = TABLET_HELP_TABS.indexOf(tab)
    let next = current
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % TABLET_HELP_TABS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + TABLET_HELP_TABS.length) % TABLET_HELP_TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABLET_HELP_TABS.length - 1
    else return
    event.preventDefault()
    focusTab(TABLET_HELP_TABS[next])
  }
  return (
    <TabletFullScreen
      title="Help"
      subtitle={tab === 'guides' ? 'Shared CanAI guides' : 'Touch gestures and tablet controls'}
      onCancel={onClose}
      cancelLabel="Done"
    >
      <div className="tablet-help">
        <div className="tablet-help-tabs" role="tablist" aria-label="Help sections" aria-orientation="horizontal">
          <button
            id="tablet-help-tab-guides"
            type="button"
            role="tab"
            aria-controls="tablet-help-panel-guides"
            aria-selected={tab === 'guides'}
            tabIndex={tab === 'guides' ? 0 : -1}
            ref={(element) => { tabRefs.current.guides = element }}
            className={tab === 'guides' ? 'active' : ''}
            onKeyDown={onTabKeyDown}
            onClick={() => setTab('guides')}
          >
            Guides
          </button>
          <button
            id="tablet-help-tab-gestures"
            type="button"
            role="tab"
            aria-controls="tablet-help-panel-gestures"
            aria-selected={tab === 'gestures'}
            tabIndex={tab === 'gestures' ? 0 : -1}
            ref={(element) => { tabRefs.current.gestures = element }}
            className={tab === 'gestures' ? 'active' : ''}
            onKeyDown={onTabKeyDown}
            onClick={() => setTab('gestures')}
          >
            Gestures
          </button>
        </div>
        <div
          id="tablet-help-panel-guides"
          role="tabpanel"
          aria-labelledby="tablet-help-tab-guides"
          tabIndex={0}
          hidden={tab !== 'guides'}
          className="tablet-help-guides"
        >
          <p className="tablet-help-intro">Guides cover shared workflows. Tablet touch controls are listed under Gestures.</p>
          <HelpPanel initialTopicId="tablet-lan" showBoardActions={false} />
        </div>
        <div
          id="tablet-help-panel-gestures"
          role="tabpanel"
          aria-labelledby="tablet-help-tab-gestures"
          tabIndex={0}
          hidden={tab !== 'gestures'}
          className="tablet-help-gestures"
        >
          <p className="tablet-help-intro">Touch-first controls for the board. Desktop-only actions stay in the desktop Help.</p>
          <div className="tablet-help-list">
            {TABLET_GESTURES.map((entry) => (
              <section className="tablet-help-row" key={entry.title}>
                <span className="tablet-help-icon" aria-hidden="true">{entry.icon}</span>
                <div>
                  <h3>{entry.title}</h3>
                  <p>{entry.note}</p>
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </TabletFullScreen>
  )
}
