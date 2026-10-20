import type { CatalogModel } from '../../types'
import type { PortDef } from './ports'
import type { NodeKind } from './types'

function selectedModel(
  models: CatalogModel[],
  kind: 'text' | 'video',
  modelId?: string,
): CatalogModel | undefined {
  const selected = models.find((model) => model.id === modelId && model.kind === kind)
  if (selected && kind === 'video' && selected.refs) {
    return models.find((model) => model.kind === 'video' && (
      model.pairId === selected.id || model.videoPairId === selected.id
    )) ?? selected
  }
  return selected ?? models.find((model) => model.kind === kind && !model.refs)
}
function connectedCount(handles: string[], prefix: string): number {
  return handles.reduce((highest, handle) => {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(handle)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0)
}

function appendDynamicPorts(
  ports: PortDef[],
  handles: string[],
  prefix: string,
  type: PortDef['type'],
  label: string,
  limit: number,
): void {
  if (limit <= 0) return
  const count = Math.min(limit, Math.max(1, connectedCount(handles, prefix) + 1))
  for (let index = 1; index <= count; index++) {
    ports.push({ id: `${prefix}${index}`, type, label: `${label} ${index}` })
  }
}

export function nodeInputPorts({
  models,
  kind,
  modelId,
  connectedHandles,
}: {
  models: CatalogModel[]
  kind: NodeKind
  modelId?: string
  connectedHandles: string[]
}): PortDef[] {
  if (kind === 'text') {
    const model = selectedModel(models, 'text', modelId)
    const modalities = new Set(model?.inputModalities ?? ['text', 'image'])
    const ports: PortDef[] = [{ id: 'ctx', type: 'text', label: 'context' }]
    if (modalities.has('image')) {
      appendDynamicPorts(ports, connectedHandles, 'ref', 'image', 'image', model?.maxImageRefs ?? 16)
    }
    if (modalities.has('video')) {
      appendDynamicPorts(ports, connectedHandles, 'video', 'video', 'video', model?.maxVideoRefs ?? 16)
    }
    if (modalities.has('audio')) {
      appendDynamicPorts(ports, connectedHandles, 'audio', 'audio', 'audio', model?.maxAudioRefs ?? 1)
    }
    return ports
  }

  if (kind === 'video') {
    const base = selectedModel(models, 'video', modelId)
    const imageModel = base?.refs
      ? base
      : models.find((model) => model.id === base?.pairId)
    const videoModel = base?.videoRefs
      ? base
      : models.find((model) => model.id === base?.videoPairId)
    const ports: PortDef[] = [{ id: 'prompt', type: 'text', label: 'prompt' }]
    appendDynamicPorts(
      ports,
      connectedHandles,
      'frame',
      'image',
      'frame',
      imageModel?.maxImageRefs ?? 0,
    )
    appendDynamicPorts(
      ports,
      connectedHandles,
      'video',
      'video',
      'video',
      videoModel?.maxVideoRefs ?? 0,
    )
    appendDynamicPorts(
      ports,
      connectedHandles,
      'audio',
      'audio',
      'audio',
      videoModel?.maxAudioRefs ?? 0,
    )
    return ports
  }

  if (kind === 'other') {
    const model = models.find((item) => item.id === modelId && item.kind === 'other')
    if (!model) return []
    const ports: PortDef[] = []
    if (model.promptRequired !== false) {
      ports.push({ id: 'prompt', type: 'text', label: 'prompt' })
    }
    if (model.refs) {
      ports.push({ id: 'image_url', type: 'image', label: 'image' })
    }
    return ports
  }

  return []
}

export function nodeOutputPorts({
  models,
  kind,
  modelId,
}: {
  models: CatalogModel[]
  kind: NodeKind
  modelId?: string
}): PortDef[] {
  const base: PortDef[] = kind === 'other'
    ? [{ id: 'out', type: 'image', label: 'image' }]
    : []
  const model = models.find((item) => item.id === modelId && item.kind === kind)
  if (model?.seedOutput) base.push({ id: 'seed', type: 'text', label: 'seed' })
  return base
}
