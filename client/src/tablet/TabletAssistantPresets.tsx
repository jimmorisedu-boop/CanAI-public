import { useCallback, useEffect, useState } from 'react'
import { api, type AssistantPreset } from '../api'
import { notify } from '../spaces/canvas/notifications'
import type { ProjectSource } from '../types'
import type { AssistantSelectionInfo } from '../spaces/canvas/AssistantPresets'
import { tabletSystemMessage } from './tabletSystemMessage'

const UNIVERSAL_BUSY_ID = '__canai_universal__'

export function TabletAssistantPresets({ projectSource = 'local', onChanged, onSelectionChanged }: {
  projectSource?: ProjectSource
  onChanged?(): void
  onSelectionChanged?(selection: AssistantSelectionInfo): void
}) {
  const [presets, setPresets] = useState<AssistantPreset[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const load = useCallback(() => {
    setLoadState('loading')
    void api.listAssistants().then((state) => {
      const sorted = [...state.presets].sort((a, b) => a.slot - b.slot)
      setPresets(sorted); setActiveId(state.activeId); setLoadState('ready')
      const active = sorted.find((preset) => preset.id === state.activeId)
      onSelectionChanged?.({ id: state.activeId, versionId: null, name: active?.name ?? (state.activeId ? null : 'Universal'), modelId: active?.modelId ?? null })
    }).catch(() => setLoadState('error'))
  }, [onSelectionChanged])
  useEffect(load, [load, projectSource])

  const toggle = async (preset: AssistantPreset | null) => {
    if (loadState !== 'ready') return
    const previous = activeId
    const next = preset === null && previous === null ? null : previous === preset?.id ? null : preset?.id ?? null
    if (previous === next) return
    setActiveId(next); setBusyId(next ?? UNIVERSAL_BUSY_ID)
    onSelectionChanged?.({ id: next, versionId: null, name: preset?.name ?? (next ? null : 'Universal'), modelId: preset?.modelId ?? null })
    try {
      const result = await api.setActiveAssistant(next)
      setActiveId(result.activeId)
      const active = presets.find((item) => item.id === result.activeId)
      onSelectionChanged?.({ id: result.activeId, versionId: null, name: active?.name ?? (result.activeId ? null : 'Universal'), modelId: active?.modelId ?? null })
      onChanged?.()
    } catch (cause) {
      setActiveId(previous)
      notify({ kind: 'error', message: tabletSystemMessage(cause, 'Could not switch assistant') })
    } finally { setBusyId(null) }
  }
  return <div className="tablet-assistant-presets" role="group" aria-label="Assistants">
    <span className="tablet-inline-label">Assistants</span>
    <div className="tablet-assistant-presets-row">
      <button type="button" className={`ui-btn quiet ${loadState === 'ready' && activeId === null ? 'on' : ''}`} aria-pressed={loadState === 'ready' && activeId === null} disabled={loadState !== 'ready' || busyId === UNIVERSAL_BUSY_ID} onClick={() => void toggle(null)}>Universal</button>
      {presets.map((preset) => <button key={preset.id} type="button" className={`ui-btn quiet ${loadState === 'ready' && activeId === preset.id ? 'on' : ''}`} aria-pressed={loadState === 'ready' && activeId === preset.id} disabled={loadState !== 'ready' || busyId === preset.id} onClick={() => void toggle(preset)}>{preset.name}</button>)}
      {loadState === 'loading' && <span className="tablet-inline-empty">Loading list…</span>}
      {loadState === 'error' && <span className="tablet-inline-empty">Could not load list</span>}
      {loadState === 'ready' && presets.length === 0 && <span className="tablet-inline-empty">You can add custom assistants on your computer</span>}
    </div>
  </div>
}
