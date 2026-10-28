import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Handle, Position, useReactFlow, useEdges, useNodes, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { IconClose, IconNext, IconPrev, IconToCanvas, IconUpload, IconTrash, IconPlus } from '../../ui/icons'
import { requestCanvasPlace } from '../canvas/canvasBus'
import { getActiveCanvasStore } from '../canvas/activeCanvasStore'
import { useModelDefaults, useModels } from './modelsContext'
import {
  inspectNodeMediaRefs,
  defaultNodeModelId,
  kindUsesBasePicker,
  pickerModels,
  referenceCapacity,
  resolveNodeModel,
  toBaseModelId,
} from './nodeModel'
import { useNodeActions } from './nodeActions'
import { ParamControls, seedDefaults } from '../../ui/ParamControls'
import { ExpandableTextarea } from '../../ui/ExpandableTextarea'
import type { JobKind, JobResult } from '../../types'
import { englishPromptWarning } from './promptLanguage'
import { MODEL_INPUT_PORTS, NODE_META, NODE_PORTS, PORT_COLORS, visibleOutputs, type PortDef, metaFor, portsFor, isKnownNodeKind } from './ports'
import type { CanaiEdge, CanaiNode, GenNodeData } from './types'
import { api } from '../../api'
import { buildMacroInputPortModel } from './macroInputPorts'
import { showErrorToast } from '../canvas/toastBus'
import { createNodeAspectTracker, nodePanelParams, settleNodeSeed } from './nodeAspect'
import { InlineNotice } from '../../ui/InlineNotice'
import { nodeInputPorts, nodeOutputPorts } from './nodePortContracts'
import { effModelSuffix, effModelTitle } from '../../ui/effModelHint'
import { handleNodePortKeyDown } from './nodeHandleKeyboard'
import { executorCompatibilityError } from '../../../../packages/model-catalog/version'
import { MediaPlaybackControls } from '../../ui/MediaPlaybackControls'
import { useT } from '../../i18n/context.js'


const HEADER_H = 34
const ROW_H = 26

// Выбор модели: image/video — только БАЗОВЫЕ (как на канвасе); ref/i2v/edit
// включаются сами по подключённым входам. Параметры — у эффективной модели.
function ModelPicker({
  id,
  data,
  hasImageRefs,
  hasVideoRefs,
  hasAudioRefs,
}: {
  id: string
  data: GenNodeData
  hasImageRefs: boolean
  hasVideoRefs: boolean
  hasAudioRefs: boolean
}) {
  const t = useT()
  const { updateNode } = useNodeActions()
  const models = useModels()
  const modelDefaults = useModelDefaults()
  const updateNodeData = updateNode

  const presets = pickerModels(models, data.kind)
  const baseId =
    kindUsesBasePicker(data.kind) && data.model
      ? toBaseModelId(models, data.model, data.kind as JobKind)
      : data.model
  const selectedPreset = presets.find((p) => p.id === baseId)
  const eff = resolveNodeModel(models, data.kind, data.model, hasImageRefs, hasVideoRefs, hasAudioRefs)

  // Only a new, unconfigured node gets a default. Saved model IDs never change on catalog refresh.
  useEffect(() => {
    if (presets.length === 0) return
    if (!data.model) {
      const initialId = defaultNodeModelId(models, data.kind, modelDefaults)
      const first = presets.find(model => model.id === initialId && !executorCompatibilityError(model))
      if (!first) return
      updateNodeData(id, { model: first.id, params: settleNodeSeed(first, seedDefaults(first.params)) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.model, presets.length, models.length, modelDefaults])

  // ⚠️ Панель обязана знать, подключён ли референс: без этого признака «Авто»
  // вырезается из списка всегда (жалоба 01.10.2026 «в ноде пропало авто
  // пропорции»). Само значение ведёт правило в теле ноды — см. nodeAspect.
  const hasMediaRefs = hasImageRefs || hasVideoRefs

  const showEffHint = Boolean(eff && selectedPreset && eff.id !== selectedPreset.id)

  return (
    <div className="node-model nodrag">
      <select
        className="node-model-select"
        value={selectedPreset ? selectedPreset.id : data.model ?? ''}
        onChange={(e) => {
          const preset = presets.find((p) => p.id === e.target.value)
          if (!preset) return
          updateNodeData(id, { model: preset.id, params: settleNodeSeed(preset, seedDefaults(preset.params)) })
        }}
      >
        {data.model && !selectedPreset && <option value={data.model} disabled>{models.find(m => m.id === data.model)?.name ?? data.model}  {t('— unavailable')}</option>}
        {presets.map((p) => (
          <option key={p.id} value={p.id} disabled={Boolean(executorCompatibilityError(p))}>
            {p.name}{executorCompatibilityError(p) ? t(' · update CanAI') : ''}
          </option>
        ))}
      </select>
      {showEffHint && eff && (
        <div
          className="node-model-eff-hint"
          title={effModelTitle('Selected from connected inputs', eff.name)}
        >
          {t('Using “{0}”', { 0: effModelSuffix(selectedPreset?.name ?? '', eff.name) })}
        </div>
      )}
      {eff && eff.params.length > 0 && (
        <ParamControls
          params={nodePanelParams(eff, data.params ?? {}, hasMediaRefs)}
          values={data.params ?? {}}
          onChange={(next) => updateNodeData(id, { params: next })}
        />
      )}
    </div>
  )
}

function ResultAudioPreview({ src }: { src: string }) {
  const mediaRef = useRef<HTMLAudioElement>(null)
  return (
    <div className="media-playback-shell">
      <audio className="node-result-audio" ref={mediaRef} src={src} preload="metadata" />
      <MediaPlaybackControls mediaRef={mediaRef} />
    </div>
  )
}

function ResultPreview({ result }: { result?: JobResult }) {
  if (!result) return null
  if (result.text) {
    return <div className="node-result-text">{result.text}</div>
  }
  if (result.url) {
    const isVideo = (result.mime ?? '').startsWith('video/')
    const isAudio = (result.mime ?? '').startsWith('audio/')
    if (isAudio) {
      return <ResultAudioPreview key={result.url} src={result.url} />
    }
    return isVideo ? (
      <video className="node-result-media" src={result.url} muted loop autoPlay />
    ) : (
      <img className="node-result-media" src={result.url} alt="" />
    )
  }
  return null
}

// Подпись текстового поля ноды — шапка большого редактора по «Развернуть».
// Называет именно ПОЛЕ, а не ноду.
function promptLabel(kind: GenNodeData['kind']): string {
  if (kind === 'combine') return 'Separator'
  if (kind === 'note') return 'Text'
  if (kind === 'text') return 'LLM instruction'
  if (kind === 'other') return 'What to detect in the image'
  return 'Prompt'
}

function statusLabel(data: GenNodeData): string | null {
  if (data.status === 'running') return data.progress ?? 'generating…'
  if (data.status === 'queued') return 'queued…'
  if (data.status === 'error') return `error: ${data.error ?? ''}`
  return null
}

export function GenNode({ id, data, selected }: NodeProps<CanaiNode>) {
  const translate = useT()
  const { setNodes, setEdges } = useReactFlow()
  const { updateNode, scope } = useNodeActions()
  const updateNodeData = updateNode
  const models = useModels()

  const [localPrompt, setLocalPrompt] = useState(data.prompt ?? '')
  useEffect(() => {
    setLocalPrompt(data.prompt ?? '')
  }, [data.prompt])

  // Все текстовые поля ноды пишут в одно и то же data.prompt и отличаются лишь
  // подсказкой и высотой — общая часть собрана здесь, чтобы кнопка «Развернуть»
  // и поведение ввода не разъезжались между типами нод.
  const promptField = {
    label: promptLabel(data.kind),
    value: localPrompt,
    className: 'gen-node-prompt nodrag nowheel',
    onChange: (next: string) => {
      setLocalPrompt(next)
      updateNodeData(id, { prompt: next })
    },
  }

  // Вид ноды может быть из прошлой версии приложения (в макросе пользователя
  // осталась «Ответ» от удалённых скриптов помощника). Такая нода рисуется
  // предупреждением и без портов — но НЕ роняет редактор: иначе макрос не
  // открыть даже для того, чтобы её удалить.
  const meta = metaFor(data.kind)
  const ports = portsFor(data.kind)
  const unknownKind = !isKnownNodeKind(data.kind)
  const contractedOutputs = nodeOutputPorts({ models, kind: data.kind, modelId: data.model })
  const outputs = contractedOutputs.length > 0
    ? contractedOutputs
    : visibleOutputs(data.kind, data.result)
  // служебные ноды Вход/Выход: без модели, промпта и своей генерации
  const isInput = data.kind === 'input'
  const isOutput = data.kind === 'output'
  const isAssistantInput = isInput && scope === 'assistant'
  const isAssistantOutput = isOutput && scope === 'assistant'
  const nodeTitle = isAssistantInput ? 'Input from assistant' : isAssistantOutput ? 'Output to assistant' : meta.title
  const isCombine = data.kind === 'combine'
  const isService = isInput || isOutput
  // «Текст» (note): постоянный текст, без модели/генерации/превью — только поле
  const isNote = data.kind === 'note'
  const isMedia = data.kind === 'media'

  const [uploading, setUploading] = useState(false)

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await api.uploadFile(file)
      updateNodeData(id, {
        result: { url: res.url, mime: res.mime },
        status: 'done',
      })
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : translate('Could not load file'))
    } finally {
      setUploading(false)
    }
  }, [id, translate, updateNodeData])

  const handleClearFile = useCallback(() => {
    updateNodeData(id, {
      result: undefined,
      assetSlot: undefined,
      status: 'idle',
    })
  }, [id, updateNodeData])

  function remove(): void {
    setNodes((ns) => ns.filter((n) => n.id !== id))
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id))
  }

  // история результатов: какой из них сейчас показываем
  const history = data.outputHistory ?? (data.result ? [data.result] : [])
  const viewIndex = Math.min(data.viewIndex ?? history.length - 1, history.length - 1)
  const viewed = history[viewIndex]

  // UI и resolver читают одну type-relative модель Input-портов.
  const allNodes = useNodes<CanaiNode>()
  const edges = useEdges<CanaiEdge>()
  const inputPortModel = useMemo(
    () => buildMacroInputPortModel(allNodes, edges),
    [allNodes, edges],
  )
  const connectedInputLabels = isInput
    ? ports.outputs.flatMap((port) => {
        const portMetadata = inputPortModel.getPort(id, port.id)
        return portMetadata ? [portMetadata.label] : []
      })
    : []

  // Подсчитываем динамически занятые и свободные порты
  const mediaRefs = useMemo(
    () => inspectNodeMediaRefs(id, edges, allNodes),
    [id, edges, allNodes],
  )
  const effModel = useMemo(
    () => resolveNodeModel(models, data.kind, data.model, mediaRefs.hasImage, mediaRefs.hasVideo, mediaRefs.hasAudio),
    [models, data.kind, data.model, mediaRefs.hasImage, mediaRefs.hasVideo, mediaRefs.hasAudio],
  )
  // ⚠️ «Авто» в пропорциях означает «подстроиться под референс», и на канвасе
  // оно включается само, стоит появиться референсу. В ноде значения
  // засеиваются от БАЗОВОЙ модели (у Grok это 1:1), а по референсу включается
  // её вариант «по референсам» — без общего правила портретный референс давал
  // квадрат (жалоба 07.09.2026). Правило живёт ЗДЕСЬ, а не в панели модели:
  // у свёрнутой ноды панели нет, а входы остаются — референс, подключённый к
  // свёрнутой ноде, иначе не включал «Авто» вовсе.
  const hasMediaRefs = mediaRefs.hasImage || mediaRefs.hasVideo
  const aspectTracker = useRef(createNodeAspectTracker())
  useEffect(() => {
    const current = data.params ?? {}
    const next = aspectTracker.current(effModel, current, hasMediaRefs, data.restoredAt)
    if (next !== current) updateNodeData(id, { params: next })
    // Значение пропорции в зависимостях НЕ стоит намеренно: с ним правило
    // срабатывало на каждый выбор человека и возвращало 'auto'. Отметка
    // restoredAt — наоборот, обязана: по ней память перехода начинается заново
    // после отмены, возврата и перечитывания графа (см. nodeAspect.ts).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effModel?.id, hasMediaRefs, data.restoredAt])

  const maxConnectedIndex = edges
    .filter((e) => e.target === id)
    .reduce((max, e) => {
      const handle = e.targetHandle ?? ''
      const match = /^(?:ref|frame)(\d+)$/.exec(handle)
      if (match) {
        const num = parseInt(match[1], 10)
        return Math.max(max, num)
      }
      return max
    }, 0)

  const maxRefs = referenceCapacity(models, data.kind, data.model)
  const refCount = Math.max(1, Math.min(maxRefs, maxConnectedIndex + 1))
  const contractedPorts = nodeInputPorts({
    models,
    kind: data.kind,
    modelId: data.model,
    connectedHandles: edges
      .filter((edge) => edge.target === id)
      .map((edge) => edge.targetHandle ?? ''),
  })

  // модель с ИМЕНОВАННЫМИ входами (Ideogram) — по эффективной, иначе базе
  const customPorts =
    data.kind === 'image'
      ? (MODEL_INPUT_PORTS[effModel?.id ?? ''] ?? MODEL_INPUT_PORTS[data.model ?? ''])
      : undefined

  // Получаем динамический список входящих портов
  const inputs: PortDef[] = []
  if (isAssistantOutput) {
    // В сценариях помощника на выходе только текстовый вход
    inputs.push({ id: 'in-text', type: 'text', label: 'text' })
  } else if (customPorts) {
    inputs.push(...customPorts)
  } else if (data.kind === 'image') {
    inputs.push({ id: 'prompt', type: 'text', label: 'prompt' })
    for (let idx = 1; idx <= refCount; idx++) {
      inputs.push({ id: `ref${idx}`, type: 'image', label: `reference ${idx}` })
    }
  } else if (data.kind === 'video') {
    inputs.push(...contractedPorts)
  } else if (data.kind === 'text') {
    inputs.push(...contractedPorts)
  } else if (data.kind === 'other' && contractedPorts.length > 0) {
    inputs.push(...contractedPorts)
  } else if (data.kind === 'combine') {
    for (let idx = 1; idx <= refCount; idx++) {
      inputs.push({ id: `ref${idx}`, type: 'text', label: `text ${idx}` })
    }
  } else {
    inputs.push(...ports.inputs)
  }

  const updateNodeInternals = useUpdateNodeInternals()
  const inputsHeight = HEADER_H + 8 + inputs.length * ROW_H

  useEffect(() => {
    updateNodeInternals(id)
    const t = setTimeout(() => {
      updateNodeInternals(id)
    }, 60)
    return () => clearTimeout(t)
  }, [id, inputs.length, data.collapsed, updateNodeInternals])

  return (
    <div
      className={`gen-node ${data.kind} status-${data.status} ${selected ? 'selected' : ''} ${data.collapsed ? 'collapsed' : ''}`}
    >
      <div
        className="gen-node-header"
        onDoubleClick={() => updateNodeData(id, { collapsed: !data.collapsed })}
        title={translate('Double-click to collapse/expand')}
      >
        <span className="gen-node-icon">
          <meta.icon size={16} />
        </span>
        <span className="gen-node-title">
          {translate(nodeTitle)}
        </span>
        <button className="gen-node-del icon-btn" title={translate('Delete node')} onClick={remove}>
          <IconClose size={15} />
        </button>
      </div>

      {/* входные порты */}
      {inputs.map((port, i) => (
        <div className="port-row in" key={port.id} style={{ top: HEADER_H + 8 + i * ROW_H }}>
          <Handle
            id={port.id}
            type="target"
            position={Position.Left}
            role="button"
            tabIndex={0}
            aria-label={translate('Input “{0}” node “{1}”', { 0: port.label, 1: nodeTitle })}
            onKeyDown={handleNodePortKeyDown}
            style={{ '--port-color': PORT_COLORS[port.type] } as React.CSSProperties}
          />
          <span className="port-label">{port.label}</span>
        </div>
      ))}

      {!data.collapsed && unknownKind && (
        <div className="gen-node-body" style={{ marginTop: inputsHeight - HEADER_H }}>
          <InlineNotice className="node-inline-notice" tone="warning">
            {translate('This node is from an older app version and no longer works. Delete it with the cross; the rest of the macro is intact.')}
          </InlineNotice>
        </div>
      )}

      {!data.collapsed && !unknownKind && (
        <div className="gen-node-body" style={{ marginTop: inputsHeight - HEADER_H }}>
          {isService ? (
            <InlineNotice className="node-inline-notice" tone="info">
              {isInput ? (
                isAssistantInput ? (
                  translate('The message and attached references from the assistant arrive at this input.')
                ) : (
                  <>
                    <div className="node-input-source-row">
                      <span className="node-assets-pick-label">{translate('Input source:')}</span>
                      <select
                        className="node-input-source-select nodrag"
                        value={data.assetSlot ?? 'canvas'}
                        onChange={(e) => {
                          const val = e.target.value
                          updateNodeData(id, {
                            assetSlot: val === 'canvas' ? undefined : parseInt(val, 10),
                          })
                        }}
                      >
                        <option value="canvas">{translate('Selection from board')}</option>
                        {[0, 1, 2, 3, 4, 5, 6, 7].map((s) => (
                          <option key={s} value={s}>
                            {translate('Asset {0}', { 0: s + 1 })}
                          </option>
                        ))}
                      </select>
                    </div>
                    {data.assetSlot == null
                      ? inputPortModel.dynamicInputCount > 1 &&
                        connectedInputLabels.length > 0
                        ? `Board selections feed connected outputs: ${connectedInputLabels
                            .map((label) => `“${label}”`)
                            .join(', ')}. Each type has its own count.`
                        : translate('What you select on the board before running the macro comes here: images and videos go to “images”, text goes to “text”.')
                      : translate('Input uses Asset {0}.', { 0: data.assetSlot + 1 })}
                  </>
                )
              ) : isAssistantOutput ? (
                translate('Everything arriving at this input appears in the assistant feed.')
              ) : (
                translate('Everything arriving at these inputs appears on the board after the macro runs.')
              )}
            </InlineNotice>
          ) : isCombine ? (
            <>
              <ExpandableTextarea
                {...promptField}
                rows={2}
                placeholder={translate('Separator between texts (newline by default)…')}
              />
              <InlineNotice className="node-inline-notice" tone="info">
                Combines text from all connected inputs into one text.
              </InlineNotice>
            </>
          ) : isNote ? (
            <ExpandableTextarea
              {...promptField}
              rows={3}
              placeholder={translate('Constant text — sent to other nodes as output')}
            />
          ) : isMedia ? (
            <div className="node-media-body nodrag">
              {uploading ? (
                <div className="node-upload-loading">{translate('Loading file…')}</div>
              ) : data.result?.url ? (
                <div className="node-media-preview-wrap">
                  <ResultPreview result={data.result} />
                  {data.assetSlot != null && (
                    <div className="node-asset-badge">
                      {translate('Asset {0}', { 0: data.assetSlot + 1 })}
                    </div>
                  )}
                  <button
                    className="node-media-clear icon-btn"
                    title={translate('Delete file')}
                    onClick={handleClearFile}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              ) : (
                <div className="node-upload-zone">
                  <label className="node-upload-btn">
                    <IconUpload size={15} />  {translate('Choose a file')}
                    <input
                      type="file"
                      accept="image/*,video/*,audio/mpeg,audio/wav,.mp3,.wav"
                      onChange={handleFileChange}
                      style={{ display: 'none' }}
                    />
                  </label>
                  <div className="node-assets-pick-group">
                    <span className="node-assets-pick-label">{translate('or from assets:')}</span>
                    <div className="node-assets-pick-btns">
                      {[0, 1, 2, 3, 4, 5, 6, 7].map((slot) => {
                        const store = getActiveCanvasStore()
                        const asset = store?.getAsset(slot)
                        return (
                          <button
                            key={slot}
                            type="button"
                            className={`node-asset-chip ${asset ? 'has-asset' : 'empty'}`}
                            title={asset ? translate('Use Asset {0}', { 0: slot + 1 }) : translate('Asset {0}  is empty on the canvas', { 0: slot + 1 })}
                            disabled={!asset}
                            onClick={() => {
                              if (!asset) return
                              updateNodeData(id, {
                                assetSlot: slot,
                                result: { url: asset.src, mime: asset.kind === 'video' ? 'video/mp4' : 'image/png' },
                                status: 'done',
                              })
                            }}
                          >
                            {translate('Asset {0}', { 0: slot + 1 })}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <ModelPicker
                id={id}
                data={data}
                hasImageRefs={mediaRefs.hasImage}
                hasVideoRefs={mediaRefs.hasVideo}
                hasAudioRefs={mediaRefs.hasAudio}
              />
              {effModel?.promptRequired !== false && (
                <ExpandableTextarea
                  {...promptField}
                  rows={2}
                  placeholder={
                    data.kind === 'text'
                      ? translate('LLM instruction…')
                      : data.kind === 'other'
                        ? 'What to detect in the image (for example, “person”, “car”)…'
                        : 'Describe what to generate…'
                  }
                />
              )}
              {englishPromptWarning(effModel, data.prompt ?? '') && (
                <InlineNotice className="node-inline-notice" tone="warning">
                  {englishPromptWarning(effModel, data.prompt ?? '')}
                </InlineNotice>
              )}
            </>
          )}



          {/* статус/история/превью/на-холст — только у генеративных нод */}
          {!isService && !isNote && !isMedia && (
            <>
              {statusLabel(data) && <div className={`gen-node-status ${data.status}`}>{statusLabel(data)}</div>}

              {history.length > 1 && (
                <div className="node-history nodrag">
                  <button
                    className="node-history-btn icon-btn"
                    disabled={viewIndex <= 0}
                    onClick={() => updateNodeData(id, { viewIndex: viewIndex - 1 })}
                  >
                    <IconPrev size={13} />
                  </button>
                  <span className="node-history-count">
                    {viewIndex + 1}/{history.length}
                  </span>
                  <button
                    className="node-history-btn icon-btn"
                    disabled={viewIndex >= history.length - 1}
                    onClick={() => updateNodeData(id, { viewIndex: viewIndex + 1 })}
                  >
                    <IconNext size={13} />
                  </button>
                </div>
              )}

              <ResultPreview result={viewed} />
              {viewed && (
                <button
                  className="node-to-canvas nodrag"
                  title={translate('Add result to canvas')}
                  onClick={() => requestCanvasPlace(viewed, metaFor(data.kind).title)}
                >
                  <IconToCanvas size={14} /> {translate('to canvas')}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* выходной порт */}
      {outputs.map((port) => {
        const label =
          (isInput ? inputPortModel.getPort(id, port.id)?.label : undefined) ??
          port.label
        return (
          <div className="port-row out" key={port.id}>
            <span className="port-label">{label}</span>
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              role="button"
              tabIndex={0}
              aria-label={translate('Output “{0}” node “{1}”', { 0: label, 1: nodeTitle })}
              onKeyDown={handleNodePortKeyDown}
              style={{ '--port-color': PORT_COLORS[port.type] } as React.CSSProperties}
            />
          </div>
        )
      })}
    </div>
  )
}
