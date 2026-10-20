import { useEffect, useState } from 'react'
import { api, type FaceModelsResponse } from '../api'
import type { FfmpegStateResponse } from '../settings/mediaToolsState'
import { IconCompare, IconInfo, IconSettings, IconSound, IconTrash, IconMagic } from '../ui/icons'
import { useCatalogModels } from '../spaces/canvas/genOptions'
import { DEFAULT_FACE_THRESHOLD } from '../spaces/canvas/compare/faceMath'
import { deviceName } from '../spaces/canvas/continuity/deviceIdentity'
import { notify } from '../spaces/canvas/notifications'
import { TabletFullScreen } from './TabletFullScreen'
import { TabletTrash } from './TabletTrash'
import { applyTheme, readTheme, type TabletTheme } from './tabletTheme'
import { tabletSystemMessage } from './tabletSystemMessage'

type Section = 'general' | 'assistant' | 'face' | 'media' | 'trash' | 'about'
const SECTIONS: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General', icon: <IconSettings size={18} /> },
  { id: 'assistant', label: 'Assistant', icon: <IconMagic size={18} /> },
  { id: 'face', label: 'Face similarity', icon: <IconCompare size={18} /> },
  { id: 'media', label: 'Video and audio', icon: <IconSound size={18} /> },
  { id: 'trash', label: 'Board trash', icon: <IconTrash size={18} /> },
  { id: 'about', label: 'About', icon: <IconInfo size={18} /> },
]

interface ServerSettings { falKeySet?: boolean; faceThreshold?: number; confirmCostAboveUsd?: number; assistantModelId?: string }

export function TabletSettings({ onClose }: { onClose(): void }) {
  const [section, setSection] = useState<Section>('general')
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const [theme, setTheme] = useState<TabletTheme>(() => readTheme())
  const [balance, setBalance] = useState<number | null>(null)
  const { models } = useCatalogModels()
  useEffect(() => {
    void api.getSettings().then((value) => setSettings(value as ServerSettings)).catch(() => {})
    void api.getFalBalance().then((value) => setBalance(value.balance)).catch(() => {})
  }, [])
  const patch = (next: Parameters<typeof api.patchSettings>[0]) => {
    setSettings((current) => ({ ...current, ...next }))
    void api.patchSettings(next).catch((cause: unknown) => notify({ kind: 'error', message: tabletSystemMessage(cause, 'Settings were not saved') }))
  }
  return <TabletFullScreen title="Settings" onCancel={onClose} cancelLabel="Done">
    <div className="tablet-settings">
      <nav className="tablet-settings-side" aria-label="Settings sections">
        {SECTIONS.map((entry) => <button key={entry.id} type="button" className={`tablet-settings-item ${section === entry.id ? 'on' : ''}`} aria-current={section === entry.id} onClick={() => setSection(entry.id)}>{entry.icon}<span>{entry.label}</span></button>)}
      </nav>
      <div className="tablet-settings-main">
        {section === 'general' && <>
          <Row title="Theme" note="The tablet keeps its theme separate from the computer."><div className="ui-toggle" role="group" aria-label="Theme">{([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']] as const).map(([value, label]) => <button key={value} type="button" className={theme === value ? 'on' : ''} aria-pressed={theme === value} onClick={() => { setTheme(value); applyTheme(value) }}>{label}</button>)}</div></Row>
          <Row title="Ask before expensive generation" note="Runs below this amount start without asking."><div className="ui-toggle" role="group" aria-label="Confirmation threshold">{[0, 0.5, 1, 5].map((value) => <button key={value} type="button" className={(settings?.confirmCostAboveUsd ?? 1) === value ? 'on' : ''} aria-pressed={(settings?.confirmCostAboveUsd ?? 1) === value} onClick={() => patch({ confirmCostAboveUsd: value })}>{value === 0 ? 'always' : `$${value.toFixed(2)}`}</button>)}</div></Row>
          <Row title="fal key" note="Set on the computer only — the key is unavailable on the tablet."><span className="ui-chip">{settings?.falKeySet ? 'set' : 'not set'}</span></Row>
          <Row title="fal balance" note="Remaining balance."><span className="ui-chip">{balance == null ? '—' : `$${balance.toFixed(2)}`}</span></Row>
        </>}
        {section === 'assistant' && <Row title="Assistant model" note="The assistant uses it in the creation dock."><select className="ui-field" aria-label="Assistant model" value={settings?.assistantModelId ?? 'gemini'} onChange={(event) => patch({ assistantModelId: event.target.value })}>{models.filter((model) => model.kind === 'text').map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Row>}
        {section === 'face' && <FaceSection threshold={settings?.faceThreshold ?? DEFAULT_FACE_THRESHOLD} onThreshold={(value) => patch({ faceThreshold: value })} />}
        {section === 'media' && <MediaSection />}
        {section === 'trash' && <TabletTrash />}
        {section === 'about' && <><Row title="This device" note="The board appears on your computer under this name."><span className="ui-chip">{deviceName()}</span></Row><Row title="What is not here" note="The node editor, assistant script editor, and external program launcher stay on the desktop."><span /></Row></>}
      </div>
    </div>
  </TabletFullScreen>
}

function Row({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <div className="tablet-settings-row"><div><h3>{title}</h3>{note && <p>{note}</p>}</div>{children}</div>
}

function FaceSection({ threshold, onThreshold }: { threshold: number; onThreshold(value: number): void }) {
  const [models, setModels] = useState<FaceModelsResponse | null>(null)
  useEffect(() => { void api.faceModelsState().then(setModels).catch(() => setModels(null)) }, [])
  return <><Row title="Same-person threshold" note="Measured on real datasets: similarity below this threshold is uncertain. Shared with the computer."><div className="tablet-threshold-row"><input type="range" min={0.1} max={0.95} step={0.01} value={threshold} aria-label="Face similarity threshold" onChange={(event) => onThreshold(Number(event.target.value))} /><span className="tablet-mono">{threshold.toFixed(2)}</span></div></Row><Row title="Recognition models" note="The tablet computes this locally; photos are not sent anywhere."><span className="ui-chip">{models?.state === 'ready' ? 'available' : 'not downloaded'}</span></Row></>
}

function MediaSection() {
  const [state, setState] = useState<FfmpegStateResponse | null>(null)
  useEffect(() => { void api.ffmpegState().then(setState).catch(() => setState(null)) }, [])
  return <Row title="ffmpeg" note="Needed for clip editing: cuts, cropping, and audio extraction. Download it on the computer."><span className="ui-chip">{state?.state === 'ready' ? 'available' : 'not downloaded'}</span></Row>
}
