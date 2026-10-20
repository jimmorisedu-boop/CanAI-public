import type { CatalogModel } from './catalog.js'
export interface IncomingRef { kind: string; src?: string; width?: number; height?: number }

const GPT_IDS = new Set(['chatgpt-image-2', 'chatgpt-image-2-edit', 'gpt-image-2.5-flare', 'gpt-image-2.5-flare-edit', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-edit'])
const SEEDREAM_IDS = new Set(['seedream-5-pro', 'seedream-5-pro-edit'])
const NANO_IDS = new Set([
  'nano-banana',
  'nano-banana-edit',
  'nano-banana-pro',
  'nano-banana-pro-edit',
])

const ASPECT_TO_IMAGE_SIZE: Record<string, string> = {
  '1:1': 'square_hd',
  '3:4': 'portrait_4_3',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '16:9': 'landscape_16_9',
}

const GPT_MAX_EDGE = 3840
const GPT_MAX_PIXELS = 8_294_400

export function findEffectiveCatalogPreset(
  catalog: CatalogModel[],
  endpoint: string,
  requestedId?: string,
): CatalogModel | undefined {
  return catalog.find((item) => item.endpoint === endpoint)
    ?? catalog.find((item) => item.id === requestedId)
}

export function usesImageParamAdapter(preset: CatalogModel): boolean {
  return GPT_IDS.has(preset.id)
    || SEEDREAM_IDS.has(preset.id)
    || NANO_IDS.has(preset.id)
}

function specDefault(preset: CatalogModel, name: string): unknown {
  return preset.params?.find((param) => param.name === name)?.default
}

function selected(
  preset: CatalogModel,
  input: Record<string, unknown>,
  name: string,
): unknown {
  return input[name] ?? specDefault(preset, name)
}

function legacyImageSize(input: Record<string, unknown>): boolean {
  return input.image_size !== undefined
    && input.aspect_ratio === undefined
    && input.resolution === undefined
}

function parseAspect(value: string): number {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value)
  if (!match) throw new Error(`Unsupported aspect ratio: ${value}`)
  const width = Number(match[1])
  const height = Number(match[2])
  if (!(width > 0 && height > 0)) {
    throw new Error(`Unsupported aspect ratio: ${value}`)
  }
  return width / height
}

function fitSeedream1K(aspectValue: string): { width: number; height: number } {
  // Named preset'ы Seedream могут вернуть 2K. Явный размер сохраняет пропорцию
  // и площадь от 1024² до 1536² (тариф 1K), обе стороны кратны 16.
  const [widthRatio, heightRatio] = aspectValue.split(':').map(Number)
  const scale = Math.ceil(1024 / Math.sqrt(widthRatio! * heightRatio!) / 16) * 16
  return { width: widthRatio! * scale, height: heightRatio! * scale }
}

function fitSeedream2K(aspectValue: string): { width: number; height: number } {
  const aspect = parseAspect(aspectValue)
  const maxPixels = 2048 * 2048
  let height = Math.floor(Math.sqrt(maxPixels / aspect) / 16) * 16
  let width = Math.floor((height * aspect) / 16) * 16
  while (width * height > maxPixels) {
    if (width >= height) width -= 16
    else height -= 16
  }
  return { width, height }
}

function firstRefAspect(refs: IncomingRef[]): number | null {
  for (const ref of refs) {
    // Источник истины — САМ ФАЙЛ, а не размеры, присланные клиентом: у объекта
    // на холсте это может быть размер карточки, а не кадра (старые доски без
    // naturalWidth), и тогда портретный референс выдавал себя за квадрат.
    const w = ref.width
    const h = ref.height
    if (
      (ref.kind === 'image' || ref.kind === 'video')
      && typeof w === 'number'
      && typeof h === 'number'
      && Number.isFinite(w)
      && Number.isFinite(h)
      && w > 0
      && h > 0
    ) {
      return w / h
    }
  }
  return null
}

function closestPresetAspect(preset: CatalogModel, aspect: number): string | null {
  const options = preset.params?.find((param) => param.name === 'aspect_ratio')?.options
  if (!options) return null

  let closest: string | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  for (const option of options) {
    if (option.value === 'auto') continue
    const distance = Math.abs(parseAspect(option.value) - aspect)
    if (distance < closestDistance) {
      closest = option.value
      closestDistance = distance
    }
  }
  return closest
}

function closestGptAspectKey(aspect: number): string {
  let closest = '4:3'
  let closestDistance = Number.POSITIVE_INFINITY
  for (const candidate of Object.keys(ASPECT_TO_IMAGE_SIZE)) {
    const distance = Math.abs(parseAspect(candidate) - aspect)
    if (distance < closestDistance) {
      closest = candidate
      closestDistance = distance
    }
  }
  return closest
}

function fitGptCustomSize(
  aspect: number,
  targetLongEdge: 1024 | 2048 | 3840,
): { width: number; height: number } {
  if (!Number.isFinite(aspect) || aspect < 1 / 3 || aspect > 3) {
    throw new Error(`Unsupported GPT Image 2 aspect ratio: ${aspect}`)
  }

  let width: number
  let height: number
  if (aspect >= 1) {
    width = targetLongEdge
    height = Math.max(16, Math.round((targetLongEdge / aspect) / 16) * 16)
  } else {
    height = targetLongEdge
    width = Math.max(16, Math.round((targetLongEdge * aspect) / 16) * 16)
  }

  const edgeScale = Math.min(1, GPT_MAX_EDGE / Math.max(width, height))
  const pixelScale = Math.min(1, Math.sqrt(GPT_MAX_PIXELS / (width * height)))
  const scale = Math.min(edgeScale, pixelScale)
  if (scale < 1) {
    width = Math.max(16, Math.floor((width * scale) / 16) * 16)
    height = Math.max(16, Math.floor((height * scale) / 16) * 16)
  }

  return { width, height }
}

/**
 * Кадр, который GPT Image уходит в fal: имя пресета, 'auto' или явный размер.
 * Одно правило на запрос и на цену (`gptImagePricing.ts`): цена считается по
 * этому же кадру, а не по строкам таблицы fal.
 */
export function gptImageSize(
  aspectValue: string,
  resolutionValue: string,
  refAspect: number | null,
): string | { width: number; height: number } {
  const resolution = resolutionValue.toUpperCase()
  if (!['AUTO', '1K', '2K', '4K'].includes(resolution)) {
    throw new Error(`Unsupported GPT Image 2 resolution: ${resolutionValue}`)
  }

  if (aspectValue === 'auto' && (resolution === 'AUTO' || resolution === '1K')) {
    // «Авто» отдаём модели КАК ЕСТЬ: по её схеме image_size='auto' означает
    // «вывести размер из входных картинок». Это точнее нашего округления к
    // ближайшему пресету, которое на портретном референсе могло дать квадрат.
    return 'auto'
  }
  const aspect = aspectValue === 'auto'
    ? refAspect ?? 4 / 3
    : parseAspect(aspectValue)

  if (resolution === 'AUTO' || resolution === '1K') {
    // 1K — только официальные preset'ы; неизвестная пропорция не должна
    // молча превращаться в квадрат через custom size (тест: 7:5 → throw)
    const named = ASPECT_TO_IMAGE_SIZE[aspectValue]
    if (!named) throw new Error(`Unsupported GPT Image 2 aspect ratio: ${aspectValue}`)
    return named
  }
  // 2K/4K требуют явного размера, поэтому «авто» здесь считаем по референсу
  return fitGptCustomSize(aspect, resolution === '2K' ? 2048 : 3840)
}

function prepareGpt(
  preset: CatalogModel,
  input: Record<string, unknown>,
  refs: IncomingRef[],
): Record<string, unknown> {
  if (legacyImageSize(input)) return { ...input }
  const aspectValue = String(selected(preset, input, 'aspect_ratio'))
  const resolutionValue = String(selected(preset, input, 'resolution'))
  const refAspect = aspectValue === 'auto' ? firstRefAspect(refs) : null
  const imageSize = gptImageSize(aspectValue, resolutionValue, refAspect)

  const output: Record<string, unknown> = { ...input, image_size: imageSize }
  delete output.aspect_ratio
  delete output.resolution
  return output
}

function prepareSeedream(
  preset: CatalogModel,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (legacyImageSize(input)) return { ...input }
  const aspect = String(selected(preset, input, 'aspect_ratio'))
  const resolution = String(selected(preset, input, 'resolution')).toUpperCase()
  if (resolution !== '1K' && resolution !== '2K') {
    throw new Error(`Unsupported Seedream resolution: ${resolution}`)
  }
  const namedSize = aspect === 'auto'
    ? `auto_${resolution}`
    : ASPECT_TO_IMAGE_SIZE[aspect]
  if (!namedSize) {
    throw new Error(`Unsupported Seedream aspect ratio: ${aspect}`)
  }
  const output: Record<string, unknown> = {
    ...input,
    image_size: aspect === 'auto'
      ? namedSize
      : resolution === '2K' ? fitSeedream2K(aspect) : fitSeedream1K(aspect),
  }
  delete output.aspect_ratio
  delete output.resolution
  return output
}

function prepareNano(
  preset: CatalogModel,
  input: Record<string, unknown>,
  refs: IncomingRef[],
): Record<string, unknown> {
  if (input.aspect_ratio !== 'auto') return { ...input }
  const refAspect = firstRefAspect(refs)
  const aspectRatio = refAspect === null ? null : closestPresetAspect(preset, refAspect)
  return aspectRatio ? { ...input, aspect_ratio: aspectRatio } : { ...input }
}

export function prepareImageParams(
  preset: CatalogModel,
  input: Record<string, unknown>,
  refs: IncomingRef[],
): Record<string, unknown> {
  if (GPT_IDS.has(preset.id)) return prepareGpt(preset, input, refs)
  if (SEEDREAM_IDS.has(preset.id)) return prepareSeedream(preset, input)
  if (NANO_IDS.has(preset.id)) return prepareNano(preset, input, refs)
  return { ...input }
}
