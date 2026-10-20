import assert from 'node:assert/strict'
import test from 'node:test'
import { CATALOG, DEFAULT_MODEL, inferKind, normalizeEndpoint } from './catalog.js'
import { validateModelRefs } from './modelRefLimits.js'

test('normalizeEndpoint accepts endpoint ids and official fal.ai model links', () => {
  assert.equal(normalizeEndpoint('fal-ai/flux/dev'), 'fal-ai/flux/dev')
  assert.equal(normalizeEndpoint('https://fal.ai/models/fal-ai/flux/dev'), 'fal-ai/flux/dev')
  assert.equal(
    normalizeEndpoint('https://fal.ai/models/example?endpoint=fal-ai/flux/dev'),
    'fal-ai/flux/dev',
  )
})

test('normalizeEndpoint never returns an arbitrary URL', () => {
  assert.equal(normalizeEndpoint('https://evilfal.ai/capture'), '')
  assert.equal(
    normalizeEndpoint('https://fal.ai/models/example?endpoint=https://evilfal.ai/capture'),
    '',
  )
  assert.equal(normalizeEndpoint('http://fal.ai/models/fal-ai/flux/dev'), '')
  assert.equal(normalizeEndpoint('fal-ai'), '')
})

test('video edit endpoints are classified as video before generic edit', () => {
  assert.equal(inferKind('xai/grok-imagine-video/edit-video'), 'video')
  assert.equal(inferKind('owner/video-edit'), 'video')
  assert.equal(inferKind('fal-ai/flux/dev/image-edit'), 'image')
})

test('fal OpenRouter endpoints are classified as text', () => {
  assert.equal(inferKind('openrouter/router'), 'text')
  assert.equal(inferKind('openrouter/router/vision'), 'text')
})

test('SeedVR Seamless публикует полный контракт upscale без фиктивного промпта', () => {
  const model = CATALOG.find((item) => item.id === 'seedvr-seamless-upscale')
  assert.ok(model)
  assert.equal(model.kind, 'other')
  assert.equal(model.endpoint, 'fal-ai/seedvr/upscale/image/seamless')
  assert.equal(model.refs, true)
  assert.equal(model.maxImageRefs, 1)
  assert.equal(model.minImageRefs, 1)
  assert.equal(model.maxTotalRefs, 1)
  assert.equal(model.promptInputField, null)
  assert.equal(model.seedOutput, true)
  assert.deepEqual(model.defaults, { sync_mode: false })
  assert.deepEqual(model.params?.map((param) => param.name), [
    'upscale_mode',
    'upscale_factor',
    'target_resolution',
    'seed',
    'noise_scale',
    'enable_safety_checker',
    'output_format',
  ])
  assert.deepEqual(
    model.params?.find((param) => param.name === 'target_resolution')?.options,
    [
      { value: '720p', label: '1K' },
      { value: '1080p', label: '2K' },
      { value: '2160p', label: '4K' },
    ],
  )
  // ⚠️ fal берёт $0.0025 за мегапиксель РЕЗУЛЬТАТА (прайс 20.10.2026).
  // Прежняя таблица по «Target resolution» не годилась для режима «×2» по
  // умолчанию и у крупной картинки занижала цену в десятки раз; размер
  // результата теперь считает оценка цены по входу (falPrices.test.ts).
  // `usd` — запас для оценок, не знающих входа: результат 4K 16:9.
  assert.deepEqual(model.pricing, {
    unit: 'image',
    usd: 0.020736,
    perOutputMegapixel: 0.0025,
  })
})

test('SeedVR Seamless отклоняет запуск без обязательной картинки до платного вызова', () => {
  assert.match(
    validateModelRefs('seedvr-seamless-upscale', 'other', []) ?? '',
    /requires an image/i,
  )
})

test('актуальный LLM-каталог общий для помощника и нод', () => {
  const textModels = CATALOG
    .filter((model) => model.kind === 'text')
    .map((model) => ({
      id: model.id,
      name: model.name,
      endpoint: model.endpoint,
      model: model.defaults?.model,
      reasoning: model.defaults?.reasoning,
      params: model.params?.map((param) => param.name),
    }))

  assert.deepEqual(textModels, [
    {
      id: 'gemini',
      name: 'Gemini 3.8 Flash',
      endpoint: 'openrouter/router',
      model: 'google/gemini-3.8-flash',
      reasoning: true,
      params: ['system_prompt', 'temperature', 'max_tokens'],
    },
    {
      id: 'chatgpt',
      name: 'GPT-6 Sol',
      endpoint: 'openrouter/router',
      model: 'openai/gpt-6-sol',
      reasoning: undefined,
      params: ['system_prompt', 'max_tokens'],
    },
    {
      id: 'claude',
      name: 'Claude Opus 5.5',
      endpoint: 'openrouter/router',
      model: 'anthropic/claude-opus-5.5',
      reasoning: undefined,
      params: ['system_prompt', 'temperature', 'max_tokens'],
    },
    {
      id: 'grok-chat',
      name: 'Grok 4.7',
      endpoint: 'openrouter/router',
      model: 'x-ai/grok-4.7',
      reasoning: undefined,
      params: ['system_prompt', 'temperature', 'max_tokens'],
    },
    {
      id: 'qwen',
      name: 'Qwen 3.8 Max',
      endpoint: 'openrouter/router',
      model: 'qwen/qwen3.8-max-0902',
      reasoning: undefined,
      params: ['system_prompt', 'temperature', 'max_tokens'],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek V4.1 Flash',
      endpoint: 'openrouter/router',
      model: 'deepseek/deepseek-v4.1-flash',
      reasoning: true,
      params: ['system_prompt', 'temperature', 'max_tokens'],
    },
  ])
  assert.equal(DEFAULT_MODEL.text.id, 'gemini')
})

test('LLM-каталог объявляет реальные media-входы и блокирует невозможные наборы до запуска', () => {
  const capabilities = Object.fromEntries(
    CATALOG.filter((model) => model.kind === 'text')
      .map((model) => [model.id, model.inputModalities]),
  )
  assert.deepEqual(capabilities, {
    gemini: ['text', 'image', 'video', 'audio'],
    chatgpt: ['text', 'image'],
    claude: ['text', 'image'],
    'grok-chat': ['text', 'image'],
    qwen: ['text', 'image', 'video'],
    deepseek: ['text', 'image'],
  })
  assert.equal(
    validateModelRefs('qwen', 'text', [{ kind: 'video', src: '/media/clip.mp4' }]),
    null,
  )
  assert.match(
    validateModelRefs('qwen', 'text', [{ kind: 'audio', src: '/media/voice.mp3' }]) ?? '',
    /does not accept audio/i,
  )
  assert.match(
    validateModelRefs('gemini', 'text', [
      { kind: 'image', src: '/media/frame.png' },
      { kind: 'video', src: '/media/clip.mp4' },
    ]) ?? '',
    /only one media type/i,
  )
})

test('Qwen содержит токенные цены и окно контекста для фоновой памяти', () => {
  const qwen = CATALOG.find((model) => model.id === 'qwen')!

  assert.deepEqual(qwen.textPricing, {
    inputPerMillion: 0.03,
    outputPerMillion: 0.13,
    cachedInputPerMillion: 0.006,
    checkedAt: '2026-10-06',
  })
  assert.equal(qwen.contextWindowTokens, 1_000_000)
})

test('все image-пропорции подписаны числами или словом Авто', () => {
  for (const model of CATALOG.filter((item) => item.kind === 'image')) {
    const aspect = model.params?.find((param) => param.name === 'aspect_ratio')
    if (!aspect) continue
    assert.equal(aspect.label, 'Aspect ratio', model.id)
    for (const option of aspect.options ?? []) {
      assert.ok(
        option.label === 'Auto' || /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(option.label),
        `${model.id}: ${option.label}`,
      )
    }
  }
})

test('GPT Image 2 публикует пропорции, разрешение и quality отдельными полями', () => {
  const base = CATALOG.find((item) => item.id === 'chatgpt-image-2')!
  const edit = CATALOG.find((item) => item.id === 'chatgpt-image-2-edit')!
  assert.deepEqual(base.params?.map((param) => param.name), [
    'aspect_ratio',
    'resolution',
    'quality',
    'num_images',
  ])
  assert.equal(base.params?.[0]?.default, '4:3')
  assert.equal(edit.params?.[0]?.default, 'auto')
  // «Авто» у разрешения убрано как сбивающее с толку (значение зависит от
  // пропорций и незаметно для пользователя): выбор только 1K/2K/4K
  assert.deepEqual(
    base.params
      ?.find((param) => param.name === 'resolution')
      ?.options
      ?.map((option) => option.value),
    ['1K', '2K', '4K'],
  )
  assert.equal(
    base.pricing?.byParams?.names.join('|'),
    'aspect_ratio|resolution|quality',
  )
  // Цена — по кадру, который уходит в fal (gptImagePricing.ts), а не по строкам
  // таблицы fal: 9:16 1K — пресет 608×1088, 2K — 1152×2048, 4K — 2160×3840.
  // Прежние 0.165/0.222/0.401 были строками 1024×1536, 2560×1440 и 3840×2160.
  assert.equal(base.pricing?.byParams?.usd['9:16|1K|high'], 0.1035)
  assert.equal(base.pricing?.byParams?.usd['9:16|2K|high'], 0.1695)
  assert.equal(base.pricing?.byParams?.usd['9:16|4K|high'], 0.40026)
  // У правки в клетке одна входная картинка ($0.013); «авто» без размера —
  // кадр 1440², самый крупный, что «авто» выдавало.
  assert.equal(edit.pricing?.byParams?.usd['auto|auto|high'], 0.29458)
  assert.equal(edit.pricing?.byParams?.usd['9:16|4K|high'], 0.41326)
})

test('Seedream публикует пропорции и разрешение отдельными полями', () => {
  const model = CATALOG.find((item) => item.id === 'seedream-5-pro')!
  assert.deepEqual(model.params?.map((param) => param.name), [
    'aspect_ratio',
    'resolution',
    'num_images',
    'enable_safety_checker',
  ])
  assert.equal(model.params?.find((param) => param.name === 'aspect_ratio')?.default, 'auto')
  assert.equal(model.params?.find((param) => param.name === 'resolution')?.default, '2K')
  assert.deepEqual(model.pricing?.byParam, {
    name: 'resolution',
    usd: { '1K': 0.0675, '2K': 0.135 },
  })
})

test('актуальные Grok HQ и Video 1.5 используют короткие имена и точные контракты fal', () => {
  const image = CATALOG.find((item) => item.id === 'grok-image-hq')!
  const edit = CATALOG.find((item) => item.id === 'grok-image-hq-edit')!
  const video = CATALOG.find((item) => item.id === 'grok-video-1-5')!

  assert.equal(image.name, 'Grok Image HQ')
  assert.equal(image.endpoint, 'xai/grok-imagine-image/quality/text-to-image')
  assert.equal(image.pairId, edit.id)
  assert.equal(edit.name, 'Grok Image HQ Edit')
  assert.equal(edit.endpoint, 'xai/grok-imagine-image/quality/edit')
  assert.equal(edit.maxImageRefs, 3)
  assert.equal(edit.pricing?.perReferenceUsd, 0.01)

  assert.equal(video.name, 'Grok Video 1.5')
  assert.equal(video.endpoint, 'xai/grok-imagine-video/v1.5/image-to-video')
  assert.equal(video.maxImageRefs, 1)
  assert.deepEqual(
    video.params?.find((param) => param.name === 'resolution')?.options?.map((option) => option.value),
    ['480p', '720p', '1080p'],
  )
  assert.deepEqual(video.pricing?.byParam?.usd, {
    '480p': 0.08,
    '720p': 0.14,
    '1080p': 0.25,
  })
})

test('на канвасе у звука одна модель — разделение дорожки', () => {
  // Решение пользователя 19.08.2026: чип «Звук» перестал быть генерацией и
  // стал разделением. Музыка и озвучка НЕ удалены — они скрыты с канваса и
  // остаются доступны в нодах, поэтому проверяем и то, и другое.
  const audio = CATALOG.filter((model) => model.kind === 'audio')
  const onCanvas = audio.filter((model) => !model.canvasHidden)
  assert.deepEqual(onCanvas.map((model) => model.id), ['sam-audio-separate'])
  for (const id of ['lyria', 'eleven-tts', 'eleven-sfx']) {
    assert.ok(audio.some((model) => model.id === id), `${id} должна остаться для нод`)
  }
  assert.equal(DEFAULT_MODEL.audio.id, 'sam-audio-separate')
})

test('разделение дорожки требует звук и берёт его одним полем', () => {
  // Модель достаёт из дорожки то, что описано промптом, поэтому без аудио
  // запускать нечего — иначе деньги спишутся впустую.
  const model = CATALOG.find((item) => item.id === 'sam-audio-separate')!
  assert.equal(model.minAudioRefs, 1)
  assert.equal(model.audioInputField, 'audio_url')
  assert.equal(model.maxTotalRefs, 1)
})
