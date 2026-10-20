import type { Icon } from '@phosphor-icons/react'
import { IconImage, IconInput, IconLLM, IconOutput, IconText, IconVideo, IconUpload, IconSettings, IconWait, IconCombine, IconWaveform, IconScissors, IconWarning } from '../../ui/icons'
import type { NodeKind } from './types'

// Типы данных, которые «текут» по связям. Цвет провода = тип данных
// (идея из Spagetti canvasConnectionRules, но компактно).
// media — первый кадр видео-ноды, когда модель умеет и i2v, и video-edit:
// принимает и картинку, и видео (как выделение на канвасе).
export type PortType = 'text' | 'image' | 'video' | 'audio' | 'media' | 'multimedia'

export interface PortDef {
  id: string
  type: PortType
  label: string
}

// ЕДИНЫЙ ПОРЯДОК ПОРТОВ во всех нодах: текст → картинка → видео → аудио.
// Провода тянутся между портами с одинаковыми номерами, поэтому разнобой в
// порядке (у «Входа» картинка стояла первой, у LLM — текст) сам по себе плодил
// пересечения линий. Новые порты добавлять по этому же правилу; динамические
// порты в nodePortContracts.ts уже ему следуют.
export const NODE_PORTS: Record<NodeKind, { inputs: PortDef[]; outputs: PortDef[] }> = {
  text: {
    inputs: [{ id: 'ctx', type: 'text', label: 'context' }],
    outputs: [{ id: 'out', type: 'text', label: 'text' }],
  },
  // постоянный текст: без входов, только текст-выход
  note: {
    inputs: [],
    outputs: [{ id: 'out', type: 'text', label: 'text' }],
  },
  image: {
    inputs: [
      { id: 'prompt', type: 'text', label: 'prompt' },
      { id: 'ref1', type: 'image', label: 'reference 1' },
    ],
    outputs: [{ id: 'out', type: 'image', label: 'image' }],
  },
  video: {
    inputs: [
      { id: 'prompt', type: 'text', label: 'prompt' },
      { id: 'frame1', type: 'image', label: 'frame 1' },
    ],
    outputs: [{ id: 'out', type: 'video', label: 'video' }],
  },
  // Вход: то, что выделено на доске при запуске макроса
  input: {
    inputs: [],
    outputs: [
      { id: 'text', type: 'text', label: 'text' },
      { id: 'images', type: 'image', label: 'image' },
      { id: 'video', type: 'video', label: 'video' },
      { id: 'audio', type: 'audio', label: 'audio' },
    ],
  },
  // Выход: всё, что сюда пришло, появится на доске
  output: {
    inputs: [
      { id: 'in-text', type: 'text', label: 'text' },
      { id: 'in-image', type: 'image', label: 'image' },
      { id: 'in-video', type: 'video', label: 'video' },
    ],
    outputs: [],
  },
  // Свой файл: загруженное пользователем изображение или видео
  media: {
    inputs: [],
    outputs: [
      { id: 'image', type: 'image', label: 'image' },
      { id: 'video', type: 'video', label: 'video' },
      { id: 'audio', type: 'audio', label: 'audio' },
    ],
  },
  other: {
    inputs: [
      { id: 'prompt', type: 'text', label: 'prompt' },
      { id: 'ref1', type: 'image', label: 'image' },
    ],
    outputs: [{ id: 'out', type: 'image', label: 'image' }],
  },
  combine: {
    inputs: [{ id: 'ref1', type: 'text', label: 'text 1' }],
    outputs: [{ id: 'out', type: 'text', label: 'text' }],
  },
  // ── звук ──
  // Модель звука. На канвасе у неё осталось одно дело — достать из дорожки
  // то, что описано словами; в нодах доступны и генеративные (музыка,
  // озвучка, эффекты), поэтому дорожка на входе НЕ обязательна.
  audio: {
    inputs: [
      { id: 'prompt', type: 'text', label: 'prompt' },
      { id: 'audio1', type: 'audio', label: 'track' },
    ],
    outputs: [{ id: 'out', type: 'audio', label: 'audio' }],
  },
  // Склейка: видео получает звук из отдельного файла. Считает наш ffmpeg,
  // денег не стоит — поэтому и живёт отдельной нодой, а не моделью.
  muxAudio: {
    inputs: [
      { id: 'video', type: 'video', label: 'video' },
      { id: 'audio', type: 'audio', label: 'track' },
    ],
    outputs: [{ id: 'out', type: 'video', label: 'video' }],
  },
  // Обратная операция: достать дорожку из видео.
  extractAudio: {
    inputs: [{ id: 'video', type: 'video', label: 'video' }],
    outputs: [{ id: 'out', type: 'audio', label: 'audio' }],
  },
}

// ⚠️ В сохранённом макросе может лежать вид ноды, которого в приложении БОЛЬШЕ
// НЕТ. Так и вышло: у пользователя в макросе «Кожа лица» осталась нода «Ответ»
// (kind: 'wait') от удалённых скриптов помощника, реестр её не знал, обращение
// к NODE_PORTS[kind].outputs падало — и одна такая нода роняла ВЕСЬ редактор
// (жалоба 20.08.2026: «Интерфейс сломался в блоке редактор макросов»). Хуже
// того, макрос нельзя было даже открыть, чтобы её убрать.
//
// Правило то же, что у публикации доски: незнакомый объект не имеет права
// отменять всё. Неизвестный вид получает пустые порты и честную подпись —
// человек видит ноду и может её удалить.
//
// ⚠️ Вид ищется по СВОИМ ключам реестра. Обычный объект отвечает «есть» и на
// имена, которые достались ему от Object: у вида `constructor` или `toString`
// порты и подпись оказывались функцией, вид считался знакомым, и редактор
// падал на такой ноде так же, как раньше на «Ответе».
const UNKNOWN_PORTS: { inputs: PortDef[]; outputs: PortDef[] } = { inputs: [], outputs: [] }

export function portsFor(kind: NodeKind): { inputs: PortDef[]; outputs: PortDef[] } {
  return isKnownNodeKind(kind) ? NODE_PORTS[kind] : UNKNOWN_PORTS
}

export const UNKNOWN_NODE_META = { icon: IconWarning, title: 'Unknown node' }

export function metaFor(kind: NodeKind): { icon: Icon; title: string } {
  return Object.hasOwn(NODE_META, kind) ? NODE_META[kind] : UNKNOWN_NODE_META
}

export function isKnownNodeKind(kind: NodeKind): boolean {
  return typeof kind === 'string' && Object.hasOwn(NODE_PORTS, kind)
}

export function visibleOutputs(
  kind: NodeKind,
  result?: { mime?: string },
): PortDef[] {
  const outputs = portsFor(kind).outputs
  if (kind !== 'media' || !result?.mime) return outputs
  if (result.mime.startsWith('video/')) {
    return outputs.filter((port) => port.type === 'video')
  }
  if (result.mime.startsWith('image/')) {
    return outputs.filter((port) => port.type === 'image')
  }
  if (result.mime.startsWith('audio/')) {
    return outputs.filter((port) => port.type === 'audio')
  }
  return []
}

// Модели с ИМЕНОВАННЫМИ входами (вместо обобщённых «референс 1..N»). Порядок и
// подписи портов заданы явно; id порта = роль, которая уходит на сервер (fal.ts
// раскладывает референсы по нужным полям модели), поэтому связать вход не с тем
// полем нельзя. Включает и текстовый порт промпта — это ПОЛНЫЙ список входов.
export const MODEL_INPUT_PORTS: Record<string, PortDef[]> = {
  // Ideogram Character Edit: инпейнт по маске с сохранением персонажа
  'ideogram-character-edit': [
    { id: 'prompt', type: 'text', label: 'prompt' },
    { id: 'image_url', type: 'image', label: 'image' },
    { id: 'mask_url', type: 'image', label: 'mask' },
    { id: 'reference_image_urls', type: 'image', label: 'character' },
  ],
}

// множество ИМЕНОВАННЫХ image-входов — для распознавания в движке и валидации связей
export const NAMED_IMAGE_HANDLES = new Set<string>(
  Object.values(MODEL_INPUT_PORTS)
    .flat()
    .filter((p) => p.type === 'image')
    .map((p) => p.id),
)

export const PORT_COLORS: Record<PortType, string> = {
  text: '#5b7cfa',
  image: '#3fb950',
  video: '#db8b3a',
  audio: '#a66ee8',
  media: '#c4a035', // кадр или видео — между image и video
  multimedia: '#b97866',
}

export const NODE_META: Record<NodeKind, { icon: Icon; title: string }> = {
  text: { icon: IconLLM, title: 'LLM' },
  note: { icon: IconText, title: 'Text' },
  image: { icon: IconImage, title: 'Image' },
  video: { icon: IconVideo, title: 'Video' },
  input: { icon: IconInput, title: 'Input — from board' },
  output: { icon: IconOutput, title: 'Output — to board' },
  media: { icon: IconUpload, title: 'File' },
  other: { icon: IconSettings, title: 'Other' },
  combine: { icon: IconCombine, title: 'Combine' },
  audio: { icon: IconWaveform, title: 'Sound' },
  muxAudio: { icon: IconCombine, title: 'Video + sound' },
  extractAudio: { icon: IconScissors, title: 'Extract audio' },
}

function findPort(kind: NodeKind, dir: 'inputs' | 'outputs', handleId: string): PortDef | undefined {
  return portsFor(kind)[dir].find((p) => p.id === handleId)
}

// dualMediaFrame: у базовой видео-модели есть videoPairId — первый «кадр»
// принимает и картинку (i2v), и видео (edit). videoRefs — только видео.
export function portType(
  kind: NodeKind,
  dir: 'inputs' | 'outputs',
  handleId: string,
  videoRefs?: boolean,
  dualMediaFrame?: boolean,
  audioRefs?: boolean,
): PortType | null {
  if (dir === 'inputs') {
    if (kind === 'combine' && handleId.startsWith('ref')) return 'text'
    if (kind === 'image' || kind === 'other' || kind === 'text') {
      if (handleId.startsWith('ref') || NAMED_IMAGE_HANDLES.has(handleId)) return 'image'
      if (kind === 'text' && handleId.startsWith('video')) return 'video'
      if (kind === 'text' && handleId.startsWith('audio')) return 'audio'
    }
    if (kind === 'video' && handleId.startsWith('video')) return 'video'
    if (kind === 'video' && handleId.startsWith('audio')) return 'audio'
    if (kind === 'video' && handleId.startsWith('frame')) {
      if (audioRefs) return 'multimedia'
      if (dualMediaFrame) return 'media'
      if (videoRefs) return 'video'
      return 'image'
    }
  }
  return findPort(kind, dir, handleId)?.type ?? null
}

// Связь допустима, если типы совпадают; media принимает image/video,
// multimedia — ещё и audio.
//
// ⚠️ В ТЕКСТОВЫЙ вход картинка НЕ идёт, хотя раньше шла. Разрешение писалось
// в июле под vision: тогда картинку в LLM было некуда подать, кроме входа
// «контекст». Сейчас у LLM свои картиночные порты (nodeInputPorts для kind
// 'text' добавляет ref-порты по модальностям модели), а под то же правило
// попал и «промпт» генератора картинок — туда картинка втыкалась молча и
// работала как референс, хотя порт называется иначе (жалоба 18.08.2026
// «почему можно подключать в не свои входы»). Порт обязан значить то, что
// написано на нём.
export function canConnect(sourceType: PortType | null, targetType: PortType | null): boolean {
  if (sourceType == null || targetType == null) return false
  if (targetType === 'multimedia') {
    return sourceType === 'image' || sourceType === 'video' || sourceType === 'audio' || sourceType === 'media' || sourceType === 'multimedia'
  }
  if (targetType === 'media') return sourceType === 'image' || sourceType === 'video' || sourceType === 'media'
  if (sourceType === 'media') return targetType === 'image' || targetType === 'video'
  if (sourceType === 'multimedia') return targetType === 'image' || targetType === 'video' || targetType === 'audio'
  return sourceType === targetType
}
