import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { CatalogModel } from './catalog.js'
import type { IncomingRef } from './refs.js'
import { saveBuffer, mediaFilePathAsync } from './storage.js'
import { parameterActive } from '../../packages/model-catalog/parameterRules.js'

type SampleKind = 'image' | 'video' | 'audio'
interface SampleFile { file: string; mime: string; name: string; hash: string }
export const FAL_TEST_SAMPLE_FILES: Record<SampleKind | 'imageEnd', SampleFile> = {
  image: { file: 'flower.jpg', mime: 'image/jpeg', name: 'Flowers — test photo', hash: '566da50a3edb9581cdd392cccf73d77e1b31108102d635d0a353da89d3c1af76' },
  imageEnd: { file: 'flower-end.jpg', mime: 'image/jpeg', name: 'Flowers — second frame', hash: 'c72a321f1c210dd6a5b196713dd5ab1f2e1e20f6bd5adf4c6b7115dfa763f49c' },
  video: { file: 'flower.mp4', mime: 'video/mp4', name: 'Flowers — short video', hash: '0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451' },
  audio: { file: 'sample.mp3', mime: 'audio/mpeg', name: 'Short test audio', hash: '41191d0727073bf848bcc8f0bd851d71a0b0058e901abb1c1b236ad327bda52e' },
}

export interface FalPreparedTestSamples {
  input: { prompt: string; refs: IncomingRef[]; params: Record<string, unknown> }
  samples: Array<{ kind: SampleKind; name: string; url: string }>
}

const storing = new Map<string, Promise<string>>()
async function storeSample(sample: SampleFile): Promise<string> {
  const existing = storing.get(sample.file)
  if (existing) return existing
  const operation = (async () => {
    const source = fileURLToPath(new URL(`../fixtures/fal-wizard/${sample.file}`, import.meta.url))
    const bytes = await fs.readFile(source)
    if (createHash('sha256').update(bytes).digest('hex') !== sample.hash) {
      throw new Error('Test file is corrupted. Restore the app files.')
    }
    const base = `fal-test-${sample.hash.slice(0, 20)}`
    const url = `/media/${base}.${sample.file.split('.').at(-1)}`
    const saved = await fs.readFile(await mediaFilePathAsync(url)).catch(() => null)
    if (saved && createHash('sha256').update(saved).digest('hex') === sample.hash) return url
    return (await saveBuffer(bytes, sample.mime, base)).url
  })()
  storing.set(sample.file, operation)
  try { return await operation } finally { storing.delete(sample.file) }
}

/** Neutral CC0 samples are bundled, so setup never uploads private board media. */
export async function prepareFalModelTestSamples(
  model: CatalogModel,
  store: (sample: SampleFile) => Promise<string> = storeSample,
): Promise<FalPreparedTestSamples> {
  const specs = model.params ?? []
  const params: Record<string, unknown> = {}
  for (const spec of specs) {
    const value = model.defaults?.[spec.name] ?? spec.default
    if (value !== undefined && ['string', 'number', 'boolean'].includes(typeof value)) params[spec.name] = value
  }
  for (const spec of specs) if (!parameterActive(spec, specs, params)) delete params[spec.name]
  if (specs.some(spec => spec.name === 'num_images')) params.num_images = 1

  const counts: Record<SampleKind, number> = {
    image: model.minImageRefs ?? 0,
    video: model.minVideoRefs ?? 0,
    audio: model.minAudioRefs ?? 0,
  }
  const capacities: Record<SampleKind, number> = {
    image: model.imageInputField ? model.maxImageRefs ?? (model.imageInputField.endsWith('_urls') ? 16 : 1) : 0,
    video: model.videoInputField ? model.maxVideoRefs ?? (model.videoInputField.endsWith('_urls') ? 16 : 1) : 0,
    audio: model.audioInputField ? model.maxAudioRefs ?? (model.audioInputField.endsWith('_urls') ? 16 : 1) : 0,
  }
  if (counts.image + counts.video + counts.audio === 0) {
    const preferred = (['image', 'video', 'audio'] as const).find(kind => capacities[kind] > 0)
    if (preferred) counts[preferred] = 1
  }
  if (counts.audio && model.audioRequiresVisualRef && !counts.image && !counts.video) {
    if (capacities.image) counts.image = 1
    else if (capacities.video) counts.video = 1
    else throw new Error('This model test requires a visual file with audio.')
  }
  if (Object.entries(counts).some(([kind, count]) => !Number.isSafeInteger(count) || count < 0 || count > capacities[kind as SampleKind])
    || counts.image + counts.video + counts.audio > (model.maxTotalRefs ?? 16)) {
    throw new Error('Could not find test files for inputs this model.')
  }
  const refs: IncomingRef[] = []
  const samples: FalPreparedTestSamples['samples'] = []
  for (const kind of ['image', 'video', 'audio'] as const) {
    for (let index = 0; index < counts[kind]; index++) {
      const sample = FAL_TEST_SAMPLE_FILES[kind === 'image' && index % 2 === 1 ? 'imageEnd' : kind]
      const url = await store(sample)
      refs.push({ kind, src: url })
      samples.push({ kind, name: sample.name, url })
    }
  }
  const prompt = model.promptInputField === null ? ''
    : model.kind === 'image' ? refs.length
      ? 'Keep content source material, make colors a little brighter. Create one image.'
      : 'Photo of yellow flowers on a green background in natural daylight.'
    : model.kind === 'video' ? 'Short calm ; videos: flowers slightly sway on wind, smooth motion camera.'
    : model.kind === 'audio' ? 'Short, calm nature audio: light wind and birdsong.'
    : 'Describe spring garden two short sentences on Russian language.'
  return { input: { prompt, refs, params }, samples }
}
