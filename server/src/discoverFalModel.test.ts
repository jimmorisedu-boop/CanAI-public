import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverFalModel } from './discoverFalModel.js'

function reply(properties: Record<string, unknown>, required = ['prompt'], category = 'text-to-image', endpoint = 'vendor/new-image') {
  const file = { type:'object', properties:{ url:{type:'string'} } }
  const output = category.includes('video') ? { video:file } : { images:{type:'array',items:file} }
  return { models: [{ endpoint_id: endpoint, metadata: { display_name: 'Новая картинка', category }, openapi: {
    servers: [{ url: 'https://queue.fal.run' }], paths: { [`/${endpoint}`]: { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties, required } } } }, responses:{'200':{content:{'application/json':{schema:{type:'object',properties:output}}}}} } } },
  } }] }
}
test('a URL imports scalar controls from its exact official schema without executing inference', async () => {
  let url = ''
  const result = await discoverFalModel('https://fal.ai/models/vendor/new-image', async input => {
    url = String(input)
    return new Response(JSON.stringify(reply({ prompt: { type:'string' }, quality: { type:'string', enum:['low','high'], default:'high' } })))
  })
  assert.equal(new URL(url).hostname, 'api.fal.ai')
  assert.equal(new URL(url).searchParams.get('endpoint_id'), 'vendor/new-image')
  assert.equal(result.model.id, 'user-vendor-new-image')
  assert.equal(result.model.promptInputField, 'prompt')
  assert.deepEqual(result.model.params?.[0].options?.map(item => item.value), ['low','high'])
  assert.equal(result.model.pricing, undefined, 'тариф после discovery вводится и подтверждается вручную')
})

test('discovery marks schemas without a prompt field explicitly', async () => {
  const result = await discoverFalModel('vendor/upscale', async () => new Response(JSON.stringify(reply(
    { resolution: { type: 'string', default: '1K' } },
    [],
    'image-upscale',
    'vendor/upscale',
  ))))
  assert.equal(result.model.promptInputField, null)
})

test('official endpoint aliases use the declared queue schema and validate the result adapter', async () => {
  const body = reply({prompt:{type:'string'}})
  const doc = body.models[0].openapi as Record<string, any>
  const post = doc.paths['/vendor/new-image'].post
  doc.info = {'x-fal-metadata':{endpointId:'vendor/canonical'}}
  doc.paths = {
    '/vendor/canonical':{post:{requestBody:post.requestBody}},
    '/vendor/canonical/requests/{request_id}':{get:{responses:post.responses}},
  }
  const fetcher:typeof fetch = async () => new Response(JSON.stringify(body))
  assert.equal((await discoverFalModel('vendor/new-image', fetcher)).model.endpoint, 'vendor/new-image')
  doc.paths['/vendor/canonical/requests/{request_id}'].get.responses['200'].content['application/json'].schema.properties = { unexpected:{type:'string'} }
  await assert.rejects(discoverFalModel('vendor/new-image', fetcher), /Result format/)
})
test('unknown required structures block a publishable draft and arbitrary hosts are never requested', async () => {
  let reads = 0
  const fetcher: typeof fetch = async () => { reads++; return new Response(JSON.stringify(reply({ prompt:{type:'string'}, special:{type:'object'} }, ['prompt','special']))) }
  await assert.rejects(discoverFalModel('https://evil.example/model', fetcher), /fal/)
  assert.equal(reads, 0)
  await assert.rejects(discoverFalModel('vendor/new-image', fetcher), /special/)
})

test('discovery preserves explicit video and audio reference fields', async () => {
  const result = await discoverFalModel('vendor/video-edit', async () => new Response(JSON.stringify(reply(
    {
      prompt: { type: 'string' },
      video_urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
      audio_url: { type: 'string' },
    },
    ['prompt', 'video_urls'],
    'video-to-video',
    'vendor/video-edit',
  ))))
  assert.equal(result.model.refs, true)
  assert.equal(result.model.videoRefs, true)
  assert.equal(result.model.videoInputField, 'video_urls')
  assert.equal(result.model.maxVideoRefs, 3)
  assert.equal(result.model.minVideoRefs, 1)
  assert.equal(result.model.audioInputField, 'audio_url')
  assert.equal(result.model.maxAudioRefs, 1)
})

test('Nano Banana 2.1 edit schema keeps optional image/video refs and provider defaults', async () => {
  const input = {
    type: 'object',
    required: ['prompt'],
    properties: {
      output_format: { title: 'Output Format', enum: ['jpeg', 'png', 'webp'], default: 'png', type: 'string' },
      resolution: { title: 'Resolution', enum: ['1K', '2K', '4K'], default: '1K', type: 'string' },
      pdf_url: { title: 'PDF URL', anyOf: [{ type: 'string' }, { type: 'null' }] },
      thinking_level: {
        title: 'Thinking Level', anyOf: [{ enum: ['minimal', 'medium', 'high'], type: 'string' }, { type: 'null' }],
        default: 'medium',
      },
      enable_web_search: { title: 'Enable Web Search', default: false, type: 'boolean' },
      image_urls: {
        title: 'Image URLs', items: { type: 'string' }, type: 'array',
        description: 'The URLs of images. Optional when video_url or pdf_url is provided.',
      },
      video_url: { title: 'Video URL', anyOf: [{ type: 'string' }, { type: 'null' }] },
      seed: { title: 'Seed', anyOf: [{ type: 'integer' }, { type: 'null' }] },
      safety_tolerance: { title: 'Safety Tolerance', enum: ['1', '2', '3', '4', '5', '6'], default: '4', type: 'string' },
      prompt: { type: 'string' },
      sync_mode: { title: 'Sync Mode', default: false, type: 'boolean' },
      num_images: { title: 'Number of Images', minimum: 1, maximum: 4, default: 1, type: 'integer' },
    },
  }
  const file = { type: 'object', properties: { url: { type: 'string' } } }
  const body = {
    models: [{
      endpoint_id: 'google/nano-banana-2.1/edit',
      metadata: { display_name: 'Nano Banana 2.1 Edit', category: 'image-to-image' },
      openapi: {
        info: { 'x-fal-metadata': { endpointId: 'fal-ai/nano-banana-2.1/edit' } },
        components: { schemas: {
          Input: input,
          Output: { type: 'object', properties: { images: { type: 'array', items: { $ref: '#/components/schemas/ImageFile' } } } },
          ImageFile: file,
        } },
        paths: {
          '/fal-ai/nano-banana-2.1/edit': {
            post: {
              requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } },
              responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Output' } } } } },
            },
          },
          '/fal-ai/nano-banana-2.1/edit/requests/{request_id}': {
            get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Output' } } } } } },
          },
        },
        servers: [{ url: 'https://queue.fal.run' }],
      },
    }],
  }

  const result = await discoverFalModel('google/nano-banana-2.1/edit', async () => new Response(JSON.stringify(body)))
  const params = new Map(result.model.params?.map(param => [param.name, param]))

  assert.equal(result.model.kind, 'image')
  assert.equal(result.model.promptInputField, 'prompt')
  assert.equal(result.model.refs, true)
  assert.equal(result.model.imageInputField, 'image_urls')
  assert.equal(result.model.conditionalReferenceRequirement, 'image-or-video-or-pdf')
  assert.equal(result.model.minImageRefs, 0)
  assert.equal(result.model.maxImageRefs, 16)
  assert.ok(result.issues.some(issue => /image_urls.*video_url.*pdf_url/i.test(issue)))
  assert.equal(result.model.videoRefs, true)
  assert.equal(result.model.videoInputField, 'video_url')
  assert.equal(result.model.minVideoRefs, 0)
  assert.equal(result.model.maxVideoRefs, 1)
  assert.equal(params.get('pdf_url')?.widget, 'textarea')
  assert.deepEqual(params.get('thinking_level')?.options?.map(option => option.value), ['minimal', 'medium', 'high'])
  assert.equal(params.get('thinking_level')?.default, 'medium')
  assert.equal(params.get('resolution')?.default, '1K')
  assert.equal(params.get('output_format')?.default, 'png')
  assert.equal(params.get('seed')?.widget, 'seed')
  assert.equal(params.get('safety_tolerance')?.default, '4')
  assert.equal(params.get('num_images')?.min, 1)
  assert.equal(params.get('num_images')?.max, 1)
  assert.equal(params.get('sync_mode'), undefined)
})
