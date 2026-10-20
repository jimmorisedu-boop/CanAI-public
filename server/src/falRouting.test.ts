import assert from 'node:assert/strict'
import test from 'node:test'
import { fal } from '@fal-ai/client'
import * as falModule from './fal.js'
import { CATALOG, resolveModel } from './catalog.js'
import { createFalBillingHistoryUrl, normalizeFalBillingHistoryPage } from './falBillingRoutes.js'

const { buildTextRequest, textEndpoint } = falModule

test('таймаут fal завершается ошибкой, даже если отмена запроса зависла', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  t.mock.method(fal.queue, 'subscribeToStatus', (
    _endpoint: Parameters<typeof fal.queue.subscribeToStatus>[0],
    options: Parameters<typeof fal.queue.subscribeToStatus>[1],
  ) =>
    new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      )
    }))
  t.mock.method(fal.queue, 'cancel', () => new Promise(() => {}))

  let outcome: { state: 'resolved' } | { state: 'rejected'; error: unknown } | undefined
  void falModule.resumeByModel(
    resolveModel('gemini', 'text', false),
    'req-timeout',
    () => {},
  ).then(
    () => { outcome = { state: 'resolved' } },
    (error: unknown) => { outcome = { state: 'rejected', error } },
  )

  await Promise.resolve()
  t.mock.timers.tick(4 * 60_000)
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(outcome?.state, 'rejected', 'Promise генерации остался незавершённым после дедлайна')
  assert.match(String(outcome && 'error' in outcome ? outcome.error : ''), /exceeded 4 min/u)
})

test('история fal запрашивает ровно 10 операций и безопасно передаёт курсор', () => {
  const url = new URL(createFalBillingHistoryUrl('next page/+='))
  assert.equal(url.searchParams.get('limit'), '10')
  assert.equal(url.searchParams.get('cursor'), 'next page/+=')
})

test('страница fal возвращает клиенту курсор только когда продолжение существует', () => {
  const page = normalizeFalBillingHistoryPage({
    billing_events: [{
      request_id: 'req-1',
      endpoint_id: 'fal-ai/example',
      timestamp: '2026-08-11T10:00:00Z',
      cost_estimate_nano_usd: 25_000_000,
    }],
    next_cursor: 'page-2',
    has_more: true,
  })

  assert.equal(page.events.length, 1)
  assert.equal(page.events[0].cost, 0.025)
  assert.equal(page.nextCursor, 'page-2')
  assert.equal(page.hasMore, true)
  assert.deepEqual(normalizeFalBillingHistoryPage({ billing_events: [], next_cursor: 'stale', has_more: false }), {
    events: [],
    nextCursor: null,
    hasMore: false,
  })
})

test('OpenRouter LLM switches to vision only when images are present', () => {
  assert.equal(textEndpoint('openrouter/router', []), 'openrouter/router')
  assert.equal(
    textEndpoint('openrouter/router', ['https://fal.media/ref.png']),
    'openrouter/router/vision',
  )
})

test('custom text endpoints are not rewritten to OpenRouter vision', () => {
  assert.equal(
    textEndpoint('owner/custom-text', ['https://fal.media/ref.png']),
    'owner/custom-text',
  )
})

test('OpenRouter LLM выбирает отдельные video и audio endpoint и поля', () => {
  assert.deepEqual(
    buildTextRequest(
      'openrouter/router',
      'Опиши видео',
      [],
      { model: 'qwen/qwen3.8-max-0902' },
      ['https://fal.media/clip.mp4'],
      [],
    ),
    {
      endpoint: 'openrouter/router/video',
      input: {
        prompt: 'Опиши видео',
        model: 'qwen/qwen3.8-max-0902',
        video_urls: ['https://fal.media/clip.mp4'],
      },
    },
  )
  assert.deepEqual(
    buildTextRequest(
      'openrouter/router',
      'Расшифруй',
      [],
      { model: 'google/gemini-3.8-flash' },
      [],
      ['https://fal.media/voice.mp3'],
    ),
    {
      endpoint: 'openrouter/router/audio',
      input: {
        prompt: 'Расшифруй',
        model: 'google/gemini-3.8-flash',
        audio_url: 'https://fal.media/voice.mp3',
      },
    },
  )
})

test('OpenRouter wrapper не маскирует неподдерживаемое смешение media', () => {
  assert.throws(
    () => buildTextRequest(
      'openrouter/router',
      'Сравни',
      ['https://fal.media/frame.png'],
      {},
      ['https://fal.media/clip.mp4'],
      [],
    ),
    /only one media type per launch/u,
  )
})

test('OpenRouter vision request contains the selected model and image_urls array', () => {
  assert.deepEqual(
    buildTextRequest(
      'openrouter/router',
      'Опиши референсы',
      ['https://fal.media/one.png', 'https://fal.media/two.png'],
      { model: 'anthropic/claude-opus-5.5', max_tokens: 1024 },
    ),
    {
      endpoint: 'openrouter/router/vision',
      input: {
        prompt: 'Опиши референсы',
        model: 'anthropic/claude-opus-5.5',
        max_tokens: 1024,
        image_urls: ['https://fal.media/one.png', 'https://fal.media/two.png'],
      },
    },
  )
})

test('Gemini 3.8 Flash всегда включает обязательный reasoning', () => {
  const model = resolveModel('gemini', 'text', false)
  const request = buildTextRequest(
    model.endpoint,
    'Составь промпт',
    [],
    model.defaults,
  )

  assert.equal(request.input.model, 'google/gemini-3.8-flash')
  assert.equal(request.input.reasoning, true)
})

test('Seedance image-to-video передаёт первый и последний кадр разными полями', () => {
  const buildVideoInput = (
    falModule as typeof falModule & {
      buildVideoInput?: (
        model: ReturnType<typeof resolveModel>,
        prompt: string,
        imageUrls: string[],
        videoUrls: string[],
        audioUrls: string[],
        params: Record<string, unknown>,
      ) => Record<string, unknown>
    }
  ).buildVideoInput
  assert.equal(typeof buildVideoInput, 'function')

  const model = resolveModel('seedance-2', 'video', true, false)
  assert.deepEqual(
    buildVideoInput?.(
      model,
      'Плавный переход между кадрами',
      ['https://fal.media/start.png', 'https://fal.media/end.png'],
      [],
      [],
      { duration: '7' },
    ),
    {
      prompt: 'Плавный переход между кадрами',
      duration: '7',
      image_url: 'https://fal.media/start.png',
      end_image_url: 'https://fal.media/end.png',
    },
  )
})

test('Seedance reference-to-video передаёт изображения, видео и аудио отдельными массивами', () => {
  const model = resolveModel('seedance-2', 'video', true, true, true)
  assert.deepEqual(
    falModule.buildVideoInput(
      model,
      'Смонтируй сцену под музыку',
      ['https://fal.media/image.png'],
      ['https://fal.media/video.mp4'],
      ['https://fal.media/audio.mp3'],
      { duration: '8' },
    ),
    {
      prompt: 'Смонтируй сцену под музыку',
      duration: '8',
      image_urls: ['https://fal.media/image.png'],
      video_urls: ['https://fal.media/video.mp4'],
      audio_urls: ['https://fal.media/audio.mp3'],
    },
  )
})

test('image model accepts explicit video input and singular image_url', async t => {
  let submittedInput: Record<string, unknown> | undefined
  t.mock.method(fal.queue, 'submit', async (
    _endpoint: Parameters<typeof fal.queue.submit>[0],
    options: Parameters<typeof fal.queue.submit>[1],
  ) => {
    submittedInput = options.input as Record<string, unknown>
    return {
      status: 'IN_QUEUE', request_id: 'image-input-test', response_url: '', status_url: '', cancel_url: '', queue_position: 0,
    }
  })
  t.mock.method(fal.queue, 'subscribeToStatus', async (
    _endpoint: Parameters<typeof fal.queue.subscribeToStatus>[0],
    options: Parameters<typeof fal.queue.subscribeToStatus>[1],
  ) => ({
    status: 'COMPLETED', request_id: options.requestId, response_url: '', status_url: '', cancel_url: '', logs: [],
  }))
  t.mock.method(fal.queue, 'result', async () => ({
    requestId: 'image-input-test', data: { images: [{ url: 'https://fal.media/generated.png' }] },
  }))

  await falModule.generateByModel(
    {
      endpoint: 'google/nano-banana-2.1/edit', kind: 'image', refs: true,
      imageInput: 'image_url', videoInput: 'video_url', audioInput: 'audio_url',
      endImageInput: null, promptInput: 'prompt', refTagStyle: null, defaults: {},
    },
    'Отредактируй',
    ['https://fal.media/reference.png'],
    ['https://fal.media/context.mp4'],
    ['https://fal.media/voice.mp3'],
    { resolution: '1K' },
    () => {},
  )

  assert.deepEqual(submittedInput, {
    output_format: 'png',
    resolution: '1K',
    prompt: 'Отредактируй',
    image_url: 'https://fal.media/reference.png',
    video_url: 'https://fal.media/context.mp4',
    audio_url: 'https://fal.media/voice.mp3',
  })
})

test('SAM 3 передаёт описание объекта в text_prompt, а не в неизвестное поле prompt', () => {
  const buildOtherInput = (
    falModule as typeof falModule & {
      buildOtherInput?: (
        model: ReturnType<typeof resolveModel>,
        prompt: string,
        imageUrls: string[],
        params: Record<string, unknown>,
      ) => Record<string, unknown>
    }
  ).buildOtherInput
  assert.equal(typeof buildOtherInput, 'function')

  const model = resolveModel('sam-image', 'other', true)
  assert.deepEqual(
    buildOtherInput?.(
      model,
      'человек в красной куртке',
      ['https://fal.media/source.png'],
      { apply_mask: true },
    ),
    {
      text_prompt: 'человек в красной куртке',
      apply_mask: true,
      image_url: 'https://fal.media/source.png',
    },
  )
})

test('SeedVR Seamless передаёт все входы и не придумывает prompt', () => {
  const model = resolveModel('seedvr-seamless-upscale', 'other', true)
  assert.deepEqual(
    falModule.buildOtherInput(
      model,
      '',
      ['https://fal.media/tile.png'],
      {
        ...model.defaults,
        upscale_mode: 'factor',
        upscale_factor: 2,
        target_resolution: '1080p',
        seed: 42,
        noise_scale: 0.1,
        enable_safety_checker: true,
        output_format: 'png',
      },
    ),
    {
      sync_mode: false,
      upscale_mode: 'factor',
      upscale_factor: 2,
      target_resolution: '1080p',
      seed: 42,
      noise_scale: 0.1,
      enable_safety_checker: true,
      output_format: 'png',
      image_url: 'https://fal.media/tile.png',
    },
  )
})

test('SeedVR Seamless сохраняет оба выхода: картинку и seed', () => {
  const model = resolveModel('seedvr-seamless-upscale', 'other', true)
  assert.deepEqual(
    falModule.parseGeneratedResult(model, {
      image: {
        url: 'https://fal.media/upscaled.png',
        width: 2048,
        height: 2048,
        content_type: 'image/png',
      },
      seed: 734,
    }),
    {
      url: 'https://fal.media/upscaled.png',
      width: 2048,
      height: 2048,
      mime: 'image/png',
      seed: 734,
    },
  )
})

// ⚠️ «Первый/последний кадр» раньше держался прибитой проверкой строки
// endpoint'а Seedance. Вторая такая модель молча теряла бы последний кадр —
// без ошибки, просто видео получалось бы не тем, за что заплатили. Теперь это
// поле каталога endImageInputField, и правило проверяется на ОБЕИХ моделях.
test('последний кадр уходит своим полем у каждой модели, которая это умеет', () => {
  for (const id of ['seedance-2-i2v', 'minimax-h3-i2v']) {
    const model = resolveModel(id, 'video', true, false)
    const input = falModule.buildVideoInput(
      model,
      'Переход',
      ['https://fal.media/start.png', 'https://fal.media/end.png'],
      [], [], {},
    )
    assert.equal(input.image_url, 'https://fal.media/start.png', `${id}: первый кадр`)
    assert.equal(input.end_image_url, 'https://fal.media/end.png', `${id}: последний кадр`)
    assert.equal(input.image_urls, undefined, `${id}: массивом эти модели картинки не берут`)
  }
})

// MiniMax H3 Max: схема сверена по openapi 27.08.2026.
test('MiniMax H3 Max сама переключается на первый/последний кадр по референсу', () => {
  assert.equal(resolveModel('minimax-h3', 'video', false, false).endpoint, 'minimax/h3-max/text-to-video')
  assert.equal(resolveModel('minimax-h3', 'video', true, false).endpoint, 'minimax/h3-max/image-to-video')
})

test('обязательное prompt_expansion_mode уходит всегда, даже если его не трогали', () => {
  const model = resolveModel('minimax-h3', 'video', false, false)
  // поле обязательное по схеме: без него fal откажет ещё до генерации
  assert.equal(model.defaults.prompt_expansion_mode, 'balanced')
  assert.equal(model.defaults.resolution, '768P', 'разрешение в enum fal — ЗАГЛАВНЫМИ')
})

test('MiniMax H3 отдаёт короткие понятные подписи сложных настроек', () => {
  const model = CATALOG.find((item) => item.id === 'minimax-h3')
  const expansion = model?.params?.find((param) => param.name === 'prompt_expansion_mode')
  const seed = model?.params?.find((param) => param.name === 'seed')

  assert.deepEqual(expansion?.options?.map((option) => option.label), ['Off', 'Medium', 'Max'])
  assert.equal(seed?.label, 'Seed')
})

