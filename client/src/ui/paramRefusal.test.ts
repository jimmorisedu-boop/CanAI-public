// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import { afterEach, test } from 'node:test'
import { api, ApiError } from '../api'
import { TabletHttpError, tabletSystemMessage } from '../tablet/tabletSystemMessage'
import { legacyParamRefusal, PARAM_REFUSAL_CODES, paramRefusalMessage } from './paramRefusal'
import { systemErrorMessage, systemMessage, SYSTEM_ERROR_FALLBACK } from './systemMessage'

// ⚠️ Отказ сервера команды «не то значение параметра» русский, а интерфейс
// английский: без этого модуля человек видел «Request failed. Open the
// diagnostic log» и не узнавал, что выбрал ступень, которой у модели нет
// (20.10.2026). Фразы сервера — дословно те, что закрепляет его сторож
// (paramLabels.test.ts в canai-cloud).
const CYRILLIC = /[А-Яа-яЁё]/u
const RU_4K = 'Модель «Grok Image» не умеет «Размер: 4K» — выберите в настройках другое значение'
const RU_AUTO = '«Авто» в «Пропорции» у модели «Grok Image HQ» работает только с референсом — подключите картинку или выберите пропорции'
const EN_4K = '“Grok Image” does not support “Resolution: 4K”. Choose another value in the settings.'
const EN_AUTO = '“Auto” in “Aspect ratio” works with “Grok Image HQ” only when a reference is attached. Attach an image or choose a specific aspect ratio.'
const DETAILS_4K = { model: 'Grok Image', param: 'size', paramLabel: 'Resolution', value: '4k', valueLabel: '4K' }
const DETAILS_AUTO = { model: 'Grok Image HQ', param: 'aspect', paramLabel: 'Aspect ratio' }

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

test('по коду и подробностям — английская фраза из подписей формы', () => {
  assert.equal(paramRefusalMessage(PARAM_REFUSAL_CODES.unsupported, DETAILS_4K), EN_4K)
  assert.equal(paramRefusalMessage(PARAM_REFUSAL_CODES.autoNeedsRefs, DETAILS_AUTO), EN_AUTO)
  assert.equal(systemMessage(RU_4K, undefined, PARAM_REFUSAL_CODES.unsupported, DETAILS_4K), EN_4K)
  // У видео подпись значения — разрешение кадра, как в форме.
  assert.equal(
    paramRefusalMessage(PARAM_REFUSAL_CODES.unsupported, { ...DETAILS_4K, model: 'Grok Video', value: '2k', valueLabel: '1080p' }),
    '“Grok Video” does not support “Resolution: 1080p”. Choose another value in the settings.',
  )
})

test('чужой код или негодные подробности — не отказ параметра', () => {
  assert.equal(paramRefusalMessage('PRICE_CONFIRMATION_REQUIRED', DETAILS_4K), null)
  assert.equal(paramRefusalMessage(PARAM_REFUSAL_CODES.unsupported, null), null)
  assert.equal(paramRefusalMessage(PARAM_REFUSAL_CODES.unsupported, ['Grok Image']), null)
  assert.equal(paramRefusalMessage(PARAM_REFUSAL_CODES.unsupported, { model: 'Grok Image', param: 'size' }), null)
  // Без кода — разбор шаблоном той же фразы.
  assert.equal(systemMessage(RU_4K, undefined, 'SOMETHING_ELSE', DETAILS_4K), EN_4K)
})

// Кода нет у прежнего сервера команды и у строковых путей: ошибка задачи
// (`job.error`) и шаг макроса доходят одной фразой.
test('русская фраза без кода узнаётся шаблоном', () => {
  assert.equal(systemMessage(RU_4K), EN_4K)
  assert.equal(systemMessage(RU_AUTO), EN_AUTO)
  assert.equal(systemErrorMessage(new Error(RU_4K)), EN_4K)
  // Прежний сервер подписывал значения по-русски: «Широкий 16:9», «Авто».
  assert.equal(
    systemMessage('Модель «Nano Banana Pro» не умеет «Пропорции: Широкий 16:9» — выберите в настройках другое значение'),
    '“Nano Banana Pro” does not support “Aspect ratio: 16:9”. Choose another value in the settings.',
  )
  assert.equal(
    systemMessage('Модель «GPT Image 2.5 Flare» не умеет «Фон: Прозрачный» — выберите в настройках другое значение'),
    '“GPT Image 2.5 Flare” does not support “Background: Transparent”. Choose another value in the settings.',
  )
  assert.equal(
    legacyParamRefusal('Модель «Seedance 2.0» не умеет «Длительность, с: 20» — выберите в настройках другое значение'),
    '“Seedance 2.0” does not support “Duration (sec): 20”. Choose another value in the settings.',
  )
  // ⚠️ В «Размер: 4K» есть «: » — английское начало сохраняется, а фраза
  // не режется посередине.
  assert.equal(systemMessage(`Generation failed: ${RU_4K}`), `Generation failed: ${EN_4K}`)
})

test('незнакомое русское слово не выдумывается — остаётся общий отказ', () => {
  assert.equal(
    systemMessage('Модель «Grok Image» не умеет «Размер: Огромный» — выберите в настройках другое значение'),
    SYSTEM_ERROR_FALLBACK,
  )
  // Обычные отказы переводятся как раньше.
  assert.equal(systemMessage('Доска не найдена'), 'Board not found.')
})

test('ответ сервера с кодом доходит до ApiError английской фразой', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
  })
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: RU_AUTO, code: PARAM_REFUSAL_CODES.autoNeedsRefs, details: DETAILS_AUTO,
  }), { status: 400, headers: { 'content-type': 'application/json' } })
  await assert.rejects(api.quoteGeneration('image', 'cat', [], 'grok-image-hq', { aspect: 'auto' },
    { projectRef: { source: 'cloud', id: 'prj_1' } } as never, 'key-1'), (error: unknown) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.message, EN_AUTO)
    assert.equal(error.originalMessage, RU_AUTO)
    assert.equal(error.code, PARAM_REFUSAL_CODES.autoNeedsRefs)
    assert.deepEqual(error.details, DETAILS_AUTO)
    assert.equal(error.status, 400)
    return true
  })
})

test('планшет: ошибка транспорта с кодом и подробностями — английская фраза', () => {
  const error = new TabletHttpError(RU_4K, 400, PARAM_REFUSAL_CODES.unsupported, DETAILS_4K)
  assert.equal(tabletSystemMessage(error), EN_4K)
  assert.equal(systemErrorMessage(error), EN_4K)
  assert.equal(tabletSystemMessage({ error: RU_AUTO, code: PARAM_REFUSAL_CODES.autoNeedsRefs, details: DETAILS_AUTO }), EN_AUTO)
  assert.equal(tabletSystemMessage(RU_AUTO), EN_AUTO)
})

test('во всех английских фразах нет кириллицы', () => {
  for (const text of [EN_4K, EN_AUTO, systemMessage(RU_4K), systemMessage(RU_AUTO)]) {
    assert.equal(CYRILLIC.test(text), false, text)
  }
})
