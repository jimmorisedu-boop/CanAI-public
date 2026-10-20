import type { CatalogModel } from '../../../types'
import type { CanvasItem } from '../konva/types'

// Подпись панели — это и есть ответ на вопрос «где тут что»: пользователь
// должен видеть роль (исходник / кандидат) и чем кандидат сделан.

export function shortPrompt(prompt: string | undefined, max = 48): string {
  if (!prompt) return ''
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export function modelName(item: CanvasItem, models: CatalogModel[]): string {
  if (!item.modelId) return ''
  return models.find((model) => model.id === item.modelId)?.name ?? item.modelId
}

export function panelLabel(
  item: CanvasItem,
  models: CatalogModel[],
  isBaseline: boolean,
): string {
  if (isBaseline) return 'Source'
  const model = modelName(item, models)
  if (model) return model
  return item.name || (item.kind === 'video' ? 'Video' : 'Image')
}

// Вторая строка подписи: чем именно эта картинка отличается по заданию.
export function panelSubLabel(item: CanvasItem, isBaseline: boolean): string {
  if (isBaseline) return item.name || ''
  return shortPrompt(item.prompt)
}
