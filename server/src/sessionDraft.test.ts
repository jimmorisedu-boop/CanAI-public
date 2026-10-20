import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isEmptySessionDraft,
  normalizeDeviceName,
  sanitizeSessionDraft,
} from './sessionDraft.js'

// Чтение и запись файла проверяются живым прогоном (модуль пишет в data/);
// здесь — правила разбора, из которых складывается безопасность черновика.

test('нормальный черновик проходит целиком', () => {
  const draft = sanitizeSessionDraft({
    prompt: 'кот в скафандре',
    kind: 'image',
    modelId: 'nano-banana',
    params: { aspect_ratio: '16:9', num_images: 2, enable_safety_checker: true },
    count: 3,
    pane: 'prompt',
    selection: ['item-1', 'asset:3'],
    manualRefs: [{ id: 'asset:3', kind: 'image', src: '/media/a.png', name: 'а.png' }],
  })
  assert.equal(draft?.prompt, 'кот в скафандре')
  assert.equal(draft?.modelId, 'nano-banana')
  assert.deepEqual(draft?.selection, ['item-1', 'asset:3'])
  assert.equal(draft?.manualRefs?.[0]?.src, '/media/a.png')
  assert.equal(draft?.count, 3)
})

test('base64 в референсе выбрасывается, а промпт остаётся', () => {
  // Священный инвариант: картинка живёт файлом, а в json — только ссылка.
  // Черновик не должен стать четвёртой дырой после items/assets/archive.
  // Выбрасываем при этом ТОЛЬКО референс: терять из-за него набранный текст —
  // ровно та потеря работы, ради предотвращения которой черновик и заведён.
  const draft = sanitizeSessionDraft({
    prompt: 'п',
    kind: 'image',
    manualRefs: [{ id: 'asset:1', kind: 'image', src: 'data:image/png;base64,AAAA' }],
  })
  assert.equal(draft?.manualRefs, undefined)
  assert.equal(draft?.prompt, 'п')
})

test('внешняя ссылка в референсе тоже не проходит', () => {
  const draft = sanitizeSessionDraft({
    prompt: 'п',
    kind: 'image',
    manualRefs: [{ id: 'asset:1', kind: 'image', src: 'https://example.com/a.png' }],
  })
  assert.equal(draft?.manualRefs, undefined)
})

test('текстовому референсу файл не нужен, а картиночному — обязателен', () => {
  const withText = sanitizeSessionDraft({
    prompt: '',
    kind: 'image',
    manualRefs: [
      { id: 'text-1', kind: 'text', text: 'подпись' },
      { id: 'img-1', kind: 'image' },
    ],
  })
  assert.equal(withText?.manualRefs?.length, 1)
  assert.equal(withText?.manualRefs?.[0]?.kind, 'text')
})

test('неизвестный тип генерации отвергает черновик целиком', () => {
  assert.equal(sanitizeSessionDraft({ prompt: 'п', kind: 'text' }), null)
  assert.equal(sanitizeSessionDraft({ prompt: 'п' }), null)
  assert.equal(sanitizeSessionDraft(null), null)
  assert.equal(sanitizeSessionDraft([1, 2]), null)
})

test('в параметрах остаются только примитивы', () => {
  const draft = sanitizeSessionDraft({
    prompt: 'п',
    kind: 'video',
    params: { duration: '8', nested: { a: 1 }, list: [1], seed: 42, ok: false },
  })
  assert.deepEqual(draft?.params, { duration: '8', seed: 42, ok: false })
})

test('счётчик держится в разумных пределах', () => {
  assert.equal(sanitizeSessionDraft({ prompt: 'п', kind: 'image', count: 0 })?.count, 1)
  assert.equal(sanitizeSessionDraft({ prompt: 'п', kind: 'image', count: 99 })?.count, 8)
})

test('длинный промпт обрезается, а не отвергается', () => {
  // Промпт — работа человека; лучше сохранить его почти целиком, чем потерять.
  const draft = sanitizeSessionDraft({ prompt: 'я'.repeat(20_000), kind: 'image' })
  assert.equal(draft?.prompt.length, 8000)
})

test('пустой черновик считается отсутствующим', () => {
  assert.equal(isEmptySessionDraft({ prompt: '   ', kind: 'image' }), true)
  assert.equal(isEmptySessionDraft({ prompt: 'кот', kind: 'image' }), false)
  assert.equal(isEmptySessionDraft({ prompt: '', kind: 'image', modelId: 'nano-banana' }), false)
})

test('имя устройства чистится и всегда непустое', () => {
  assert.equal(normalizeDeviceName('  Windows   '), 'Windows')
  assert.equal(normalizeDeviceName('Win\u0000dows'), 'Win dows')
  assert.equal(normalizeDeviceName(''), 'other device')
  assert.equal(normalizeDeviceName(undefined), 'other device')
  assert.equal(normalizeDeviceName('д'.repeat(80)).length, 40)
})
