import { normalizeEndpoint, type CatalogModel, type ParamSpec } from './catalog.js'

type RecordValue = Record<string, unknown>
export class FalDiscoveryError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const strings = (value: unknown) => array(value).filter((item): item is string => typeof item === 'string')

function resolve(raw: unknown, document: RecordValue, depth = 0): RecordValue {
  if (depth > 10) throw new FalDiscoveryError('Too complex schema fal')
  const schema = object(raw)
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#/components/schemas/')) throw new FalDiscoveryError('Schema contains external link')
    const key = schema.$ref.slice('#/components/schemas/'.length)
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new FalDiscoveryError('Invalid link schema')
    return resolve(object(object(document.components).schemas)[key], document, depth + 1)
  }
  const union = array(schema.anyOf).map(value => resolve(value, document, depth + 1)).filter(value => value.type !== 'null')
  const scalar = union.find(value => Array.isArray(value.enum)) ?? (union.length === 1 ? union[0] : undefined)
  return scalar ? { ...schema, ...scalar } : schema
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new FalDiscoveryError(`fal.ai did not return a schema (${response.status})`, 502)
  if (!response.body) throw new FalDiscoveryError('fal.ai returned an empty response')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 4 * 1024 * 1024) throw new FalDiscoveryError('The fal schema is too large')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

/** The supplied URL is an identifier; only the fixed official catalog is requested. */
export async function discoverFalModel(input: string, fetcher: typeof fetch = fetch): Promise<{ model: CatalogModel; issues: string[] }> {
  const endpoint = typeof input === 'string' && input.length <= 1024 ? normalizeEndpoint(input) : ''
  if (!endpoint) throw new FalDiscoveryError('An official fal.ai model link is required')
  const source = `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(endpoint)}&expand=openapi-3.0`
  let response: Response
  try { response = await fetcher(source, { redirect:'error', signal:AbortSignal.timeout(15_000), headers:{ accept:'application/json' } }) }
  catch { throw new FalDiscoveryError('Could not contact the fal.ai catalog. Try again later.', 502) }
  const body = object(await readJson(response))
  const row = array(body.models).map(object).find(item => item.endpoint_id === endpoint)
  if (!row) throw new FalDiscoveryError('Model not found in the official fal.ai catalog')
  const metadata = object(row.metadata), document = object(row.openapi)
  if (array(document.servers).some(server => !['https://queue.fal.run','https://fal.run'].includes(String(object(server).url)))) throw new FalDiscoveryError('Unknown server in the fal.ai schema')
  const paths = object(document.paths)
  // fal publishes some public aliases under the canonical queue endpoint.
  // This identifier selects a schema only; requests still use the supplied endpoint.
  const schemaEndpoint = normalizeEndpoint(String(object(object(document.info)['x-fal-metadata']).endpointId ?? endpoint))
  const operationPath = object(paths[`/${endpoint}`] ?? paths[`/${schemaEndpoint}`])
  const operation = object(operationPath.post)
  const schema = resolve(object(object(object(operation.requestBody).content)['application/json']).schema, document)
  const properties = object(schema.properties), required = new Set(strings(schema.required))
  if (!Object.keys(properties).length) throw new FalDiscoveryError('fal has not published parameters for this model')
  const category = String(metadata.category ?? '')
  const kind = /video/.test(category) ? 'video' : /image/.test(category) ? 'image' : /audio|speech|music/.test(category) ? 'audio' : /llm|text/.test(category) ? 'text' : null
  if (!kind) throw new FalDiscoveryError('Result type is undefined; check the description')
  const resultOperation = object(object(paths[`/${schemaEndpoint}/requests/{request_id}`]).get)
  const output = resolve(object(object(object(object(resultOperation.responses ?? operation.responses)['200']).content)['application/json']).schema, document)
  const outputProperties = object(output.properties)
  const fileHasUrl = (raw: unknown) => resolve(object(resolve(raw, document).properties).url, document).type === 'string'
  const supportedOutput = kind === 'image'
    ? fileHasUrl(resolve(outputProperties.images, document).items)
    : kind === 'video' ? fileHasUrl(outputProperties.video)
      : kind === 'audio' ? fileHasUrl(outputProperties.audio) || fileHasUrl(outputProperties.target)
        : ['output','text','response'].some(name => resolve(outputProperties[name], document).type === 'string')
  if (!supportedOutput) throw new FalDiscoveryError('Result format is unsupported by the current executor. Add a model adapter before publishing.')
  const params: ParamSpec[] = [], issues: string[] = []
  let promptInputField: CatalogModel['promptInputField'] = null
  let imageInputField: 'image_url' | 'image_urls' | undefined
  let maxImageRefs: number | undefined, minImageRefs: number | undefined
  let conditionalReferenceRequirement: CatalogModel['conditionalReferenceRequirement']
  let videoInputField: 'video_url' | 'video_urls' | undefined
  let maxVideoRefs: number | undefined, minVideoRefs: number | undefined
  let audioInputField: 'audio_url' | 'audio_urls' | undefined
  let maxAudioRefs: number | undefined, minAudioRefs: number | undefined
  for (const [name, raw] of Object.entries(properties)) {
    if (['__proto__','constructor','prototype'].includes(name) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new FalDiscoveryError('Invalid field names in the fal schema')
    const property = resolve(raw, document)
    if (name === 'prompt') {
      promptInputField = 'prompt'
      continue
    }
    if (name === 'image_url' || name === 'image_urls') {
      if (imageInputField) throw new FalDiscoveryError('Multiple image fields require explicit reference settings')
      imageInputField = name; minImageRefs = required.has(name) ? Math.max(1, Number(property.minItems) || 1) : 0
      maxImageRefs = name === 'image_url' ? 1 : Math.min(16, Number(property.maxItems) || 16)
      if (name === 'image_urls' && typeof property.description === 'string'
        && /optional\s+when[\s\S]*(?:\bvideo_url\b[\s\S]*\bpdf_url\b|\bpdf_url\b[\s\S]*\bvideo_url\b)/i.test(property.description)) {
        conditionalReferenceRequirement = 'image-or-video-or-pdf'
        issues.push('Schema: image_urls may be omitted only when video_url or pdf_url is present.')
      }
      continue
    }
    if (name === 'video_url' || name === 'video_urls') {
      if (videoInputField) throw new FalDiscoveryError('Multiple video fields require explicit reference settings')
      videoInputField = name
      minVideoRefs = required.has(name) ? Math.max(1, Number(property.minItems) || 1) : 0
      maxVideoRefs = name === 'video_url' ? 1 : Math.min(16, Number(property.maxItems) || 16)
      continue
    }
    if (name === 'audio_url' || name === 'audio_urls') {
      if (audioInputField) throw new FalDiscoveryError('Multiple audio fields require explicit reference settings')
      audioInputField = name; minAudioRefs = required.has(name) ? Math.max(1, Number(property.minItems) || 1) : 0
      maxAudioRefs = name === 'audio_url' ? 1 : Math.min(16, Number(property.maxItems) || 16)
      continue
    }
    if (['sync_mode','webhook_url','callback_url','api_key','authorization','headers'].includes(name)) {
      if (required.has(name) && property.default === undefined) throw new FalDiscoveryError(`Required field ${name} not supported`)
      continue
    }
    const spec: ParamSpec = { name, label: String(property.title ?? name).slice(0,120), widget:'textarea' }
    const type = property.type
    if (Array.isArray(property.enum) && property.enum.every(value => typeof value === 'string')) {
      spec.widget = 'select'; spec.options = strings(property.enum).map(value => ({ value, label:value }))
    } else if (type === 'boolean') spec.widget = 'boolean'
    else if (type === 'number' || type === 'integer') {
      if (property.enum) throw new FalDiscoveryError(`Numeric list ${name} requires an explicit description`)
      spec.widget = name === 'seed' ? 'seed' : 'number'
      if (typeof property.minimum === 'number') spec.min = property.minimum
      if (typeof property.maximum === 'number') spec.max = property.maximum
      if (type === 'integer') spec.step = 1
    } else if (type !== 'string') {
      if (required.has(name)) throw new FalDiscoveryError(`Required field ${name} is not supported by the current executor`)
      issues.push(`Field ${name} has a complex structure; the provider default is used.`); continue
    }
    if (property.default !== undefined && property.default !== null) spec.default = property.default
    if (required.has(name) && spec.default === undefined) throw new FalDiscoveryError(`Required field ${name} requires a default value before publishing`)
    // One job corresponds to one result. Quantity is managed by the canvas.
    if (name === 'num_images') { spec.default = 1; spec.min = spec.max = 1 }
    params.push(spec)
  }
  const model: CatalogModel = { id:`user-${endpoint.replace(/[^A-Za-z0-9_-]/g,'-').slice(0,85)}`,
    name:String(metadata.display_name ?? endpoint).slice(0,120), endpoint, kind, params, promptInputField,
    ...(imageInputField || videoInputField || audioInputField ? {
      refs: true,
      ...(imageInputField ? { imageInputField, minImageRefs, maxImageRefs } : {}),
      ...(conditionalReferenceRequirement ? { conditionalReferenceRequirement } : {}),
      ...(videoInputField ? { videoRefs: true, videoInputField, minVideoRefs, maxVideoRefs } : {}),
      ...(audioInputField ? { audioInputField, minAudioRefs, maxAudioRefs } : {}),
    } : {}),
    pricingNote:'Fal cost is not confirmed. Check model pricing; the final charge depends on the request.',
  }
  issues.push('Description imported from fal. No paid generation was run for this check.')
  return { model, issues }
}
