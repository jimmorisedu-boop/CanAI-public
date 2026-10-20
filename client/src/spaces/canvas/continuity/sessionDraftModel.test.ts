// @ts-expect-error Тест запускается через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Тест запускается через tsx с Node-типами.
import test from 'node:test'
import {
  buildSessionDraft,
  canApplyDraft,
  canApplyDraftSettings,
  cleanDraftParams,
  draftRefToRef,
  isForeignDraft,
  refToDraftRef,
  sameDraft,
} from './sessionDraftModel'

test('референс уезжает в черновик ссылкой на файл', () => {
  const ref = refToDraftRef({ shapeId: 'i1', kind: 'image', label: 'кот.png', src: '/media/кот.png' })
  assert.deepEqual(ref, { id: 'i1', kind: 'image', src: '/media/кот.png', name: 'кот.png' })
})

test('копия картинки в черновик не попадает', () => {
  // Инвариант «без base64» действует и здесь: иначе черновик стал бы ещё одной
  // дырой, через которую растр уезжает в json.
  assert.equal(refToDraftRef({ shapeId: 'i1', kind: 'image', label: 'к', src: 'data:image/png;base64,AA' }), null)
  assert.equal(refToDraftRef({ shapeId: 'i1', kind: 'image', label: 'к', src: 'https://e.com/a.png' }), null)
  assert.equal(refToDraftRef({ shapeId: 'i1', kind: 'image', label: 'к' }), null)
})

test('референс командной доски сохраняет внутренний desktop или /v3 путь', () => {
  assert.deepEqual(
    refToDraftRef({ shapeId: 'cloud-1', kind: 'image', label: 'облако', src: '/api/cloud-assets/assets/ast_ref' }),
    { id: 'cloud-1', kind: 'image', src: '/api/cloud-assets/assets/ast_ref', name: 'облако' },
  )
  assert.deepEqual(
    refToDraftRef({ shapeId: 'cloud-2', kind: 'video', label: 'клип', src: '/v3/assets/ast_clip' }),
    { id: 'cloud-2', kind: 'video', src: '/v3/assets/ast_clip', name: 'клип' },
  )
  assert.equal(
    refToDraftRef({ shapeId: 'cloud-3', kind: 'image', label: 'чужой', src: '/v3/assets/not-an-asset' }),
    null,
  )
})

test('текстовый референс переносится содержимым', () => {
  const ref = refToDraftRef({ shapeId: 't1', kind: 'text', label: 'подпись', text: '  кадр из фильма  ' })
  assert.deepEqual(ref, { id: 't1', kind: 'text', text: 'кадр из фильма', name: 'подпись' })
  assert.equal(refToDraftRef({ shapeId: 't2', kind: 'text', label: 'empty', text: '   ' }), null)
})

test('обратный перевод сохраняет то, чем пользуется промпт-бар', () => {
  const back = draftRefToRef({ id: 'i1', kind: 'image', src: '/media/a.png', name: 'a.png' })
  assert.equal(back.shapeId, 'i1')
  assert.equal(back.label, 'a.png')
  assert.equal(back.src, '/media/a.png')
})

test('черновик собирается только из осмысленного', () => {
  const draft = buildSessionDraft({
    prompt: 'кот',
    kind: 'image',
    modelId: 'nano-banana',
    params: { aspect_ratio: '16:9' },
    count: 1,
    selection: [],
    manualRefs: [],
  })
  // Счётчик 1, пустое выделение и пустые референсы в черновике не нужны:
  // это значения по умолчанию, а не выбор человека.
  assert.deepEqual(draft, {
    prompt: 'кот',
    kind: 'image',
    modelId: 'nano-banana',
    params: { aspect_ratio: '16:9' },
  })
})

test('в параметрах остаются только примитивы', () => {
  assert.deepEqual(cleanDraftParams({ a: 1, b: 'x', c: true, d: { n: 1 }, e: undefined, f: NaN }), {
    a: 1,
    b: 'x',
    c: true,
  })
  assert.equal(cleanDraftParams({}), undefined)
  assert.equal(cleanDraftParams(undefined), undefined)
})

test('черновик не подставляется поверх набранного', () => {
  // Единственное, чего нельзя делать никогда: затереть работу человека
  // промптом с другого устройства.
  assert.equal(canApplyDraft({ prompt: '', kind: 'image' }), true)
  assert.equal(canApplyDraft({ prompt: '   ', kind: 'image' }), true)
  assert.equal(canApplyDraft({ prompt: 'уже набрано', kind: 'image' }), false)
  assert.equal(
    canApplyDraft({
      prompt: '',
      kind: 'image',
      manualRefs: [{ shapeId: 'a', kind: 'image', label: 'a', src: '/media/a.png' }],
    }),
    false,
  )
})

test('настройки черновика возвращаются поверх уже загруженного текста того же типа', () => {
  assert.equal(
    canApplyDraftSettings(
      { prompt: 'текст помощника', kind: 'image' },
      { kind: 'image' },
    ),
    true,
  )
  assert.equal(
    canApplyDraftSettings(
      { prompt: 'текст помощника', kind: 'video' },
      { kind: 'image' },
    ),
    false,
  )
})

test('свой же черновик чужим не считается', () => {
  assert.equal(isForeignDraft('Windows', 'iPad'), true)
  assert.equal(isForeignDraft('iPad', 'iPad'), false)
  assert.equal(isForeignDraft('  windows ', 'Windows'), false)
})

test('одинаковые черновики распознаются как одинаковые', () => {
  const a = buildSessionDraft({ prompt: 'кот', kind: 'image' })
  const b = buildSessionDraft({ prompt: 'кот', kind: 'image' })
  assert.equal(sameDraft(a, b), true)
  assert.equal(sameDraft(a, buildSessionDraft({ prompt: 'пёс', kind: 'image' })), false)
})
