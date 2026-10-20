import type { Edge, Node } from '@xyflow/react'
import type { JobResult } from '../../types'

// input/output — служебные ноды: вход (выделение с доски) и выход (на доску).
// note — постоянный текст: вписываешь строку, она уходит на выход в другие
// ноды (не генерирует; 'text' — это LLM-нода, она текст ГЕНЕРИРУЕТ моделью).
export type NodeKind = 'text' | 'note' | 'image' | 'video' | 'audio' | 'muxAudio' | 'extractAudio' | 'input' | 'output' | 'media' | 'other' | 'combine'
export type NodeStatus = 'idle' | 'queued' | 'running' | 'done' | 'error'

// Данные одной ноды. type (не interface) — чтобы подходило под
// ограничение React Flow Node<Record<string, unknown>>.
export type GenNodeData = {
  kind: NodeKind
  prompt: string
  // выбранная модель: id пресета из каталога или свой fal-endpoint (пусто = дефолт по типу)
  model?: string
  // значения настроек модели (поля формы)
  params?: Record<string, unknown>
  status: NodeStatus
  progress?: string
  result?: JobResult
  error?: string
  // история результатов (листание версий) и индекс просматриваемой
  outputHistory?: JobResult[]
  viewIndex?: number
  // свёрнутая нода (только шапка и порты)
  collapsed?: boolean
  // Отметка программной замены графа (отмена, возврат, загрузка): по ней нода
  // понимает, что её параметры вернули, а не изменили. В макрос не сохраняется.
  restoredAt?: number
  // количество входящих референс-портов (для динамических входов)
  refCount?: number
  // ID запущенной фоновой задачи (для отслеживания)
  jobId?: string
  // номер привязанного ассета (0, 1, 2, 3)
  assetSlot?: number
}

export type CanaiNode = Node<GenNodeData>
export type CanaiEdge = Edge

export interface GraphSnapshot {
  nodes: CanaiNode[]
  edges: CanaiEdge[]
}
