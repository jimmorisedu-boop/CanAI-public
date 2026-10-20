import { useCallback, useEffect, useState } from 'react'
import { api, type AssistantPreset } from '../api'
import { notify } from '../spaces/canvas/notifications'
import type { ProjectSource } from '../types'
import type { AssistantSelectionInfo } from '../spaces/canvas/AssistantPresets'
import { tabletSystemMessage } from './tabletSystemMessage'

export interface TabletAssistantItem extends AssistantPreset { versionId?: string | null }
export interface UseTabletAssistantSelectionOptions {
  projectSource?: ProjectSource
  onChanged?(): void
  onSelectionChanged?(selection: AssistantSelectionInfo): void
}

/** Local assistant selection shared by the tablet prompt and preset strip. */
export function useTabletAssistantSelection({ projectSource = 'local', onChanged, onSelectionChanged }: UseTabletAssistantSelectionOptions = {}) {
  const [presets, setPresets] = useState<TabletAssistantItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const load = useCallback(() => {
    setLoadState('loading')
    void api.listAssistants().then((state) => {
      const sorted = [...state.presets].sort((a, b) => a.slot - b.slot).map((preset) => ({ ...preset, versionId: null }))
      setPresets(sorted); setActiveId(state.activeId); setLoadState('ready')
      const active = sorted.find((preset) => preset.id === state.activeId)
      onSelectionChanged?.({ id: state.activeId, versionId: active?.versionId ?? null, name: active?.name ?? (state.activeId ? null : 'Universal'), modelId: active?.modelId ?? null })
    }).catch(() => setLoadState('error'))
  }, [onSelectionChanged])
  useEffect(load, [load, projectSource])
  const select = useCallback(async (nextId: string | null) => {
    if (loadState !== 'ready' || nextId === activeId) return
    const previous = activeId
    setActiveId(nextId); setBusyId(nextId ?? '__canai_universal__')
    const preset = nextId ? presets.find((item) => item.id === nextId) : null
    onSelectionChanged?.({ id: nextId, versionId: preset?.versionId ?? null, name: preset?.name ?? (nextId ? null : 'Universal'), modelId: preset?.modelId ?? null })
    try {
      const result = await api.setActiveAssistant(nextId)
      setActiveId(result.activeId)
      const active = presets.find((item) => item.id === result.activeId)
      onSelectionChanged?.({ id: result.activeId, versionId: active?.versionId ?? null, name: active?.name ?? (result.activeId ? null : 'Universal'), modelId: active?.modelId ?? null })
      onChanged?.()
    } catch (cause) {
      setActiveId(previous)
      notify({ kind: 'error', message: tabletSystemMessage(cause, 'Could not switch assistant') })
    } finally { setBusyId(null) }
  }, [activeId, loadState, onChanged, onSelectionChanged, presets])
  const toggle = useCallback((preset: TabletAssistantItem | null) => {
    const id = preset?.id ?? null
    return select(preset === null && activeId === null ? null : activeId === id ? null : id)
  }, [activeId, select])
  return { presets, activeId, busyId, loadState, select, toggle, reload: load }
}
