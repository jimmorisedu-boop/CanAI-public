import { createContext, useContext } from 'react'
import type { CatalogDefaults, CatalogModel } from '../../types'

// Каталог моделей fal грузится один раз в NodesSpace и раздаётся нодам
// через контекст (ноды рендерятся React Flow, общих пропсов нет).
export interface ModelsContextValue {
  models: CatalogModel[]
  defaults?: CatalogDefaults
}

export const ModelsContext = createContext<ModelsContextValue>({ models: [] })

export function useModels(): CatalogModel[] {
  return useContext(ModelsContext).models
}

export function useModelDefaults(): CatalogDefaults | undefined {
  return useContext(ModelsContext).defaults
}
