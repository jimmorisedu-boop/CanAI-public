import { createContext, useContext } from 'react'
import type { MacroScope } from '../../api'
import type { GenNodeData } from './types'

// Действия ноды, доступные её компоненту (ноды рендерит React Flow,
// пропсы напрямую не передать — раздаём через контекст).
export interface NodeActions {
  updateNode: (id: string, patch: Partial<GenNodeData>) => void
  // область макроса: у помощника output-нода работает как «Выход в чат»
  scope: MacroScope
}

export const NodeActionsContext = createContext<NodeActions>({
  updateNode: () => {},
  scope: 'canvas',
})

export function useNodeActions(): NodeActions {
  return useContext(NodeActionsContext)
}
