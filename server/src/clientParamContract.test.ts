import test from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG, type CatalogModel, type ParamSpec } from './catalog.js'
import { validateModelParams } from './modelParams.js'
import { effectiveCatalogPreset } from './modelRefLimits.js'
import type { IncomingRef } from './refs.js'
import {
  materializeModelParams as materializeForClient,
  reconcileModelParams as reconcileForClient,
} from '../../client/src/spaces/canvas/modelParamContract.js'
import type { CatalogModel as ClientCatalogModel } from '../../client/src/types.js'

// Сторож одного контракта на две стороны: всё, что клиент готовит к отправке
// (materializeModelParams), сервер обязан принять (validateModelParams). Иначе
// человек видит «Parameters do not match the selected model» — фразу, по
// которой не понять, какую ручку тронуть.

// Каталог приходит клиенту из GET /api/models: там refs всегда булево.
const forClient = (model: CatalogModel): ClientCatalogModel => ({ ...model, refs: Boolean(model.refs) }) as ClientCatalogModel
const reconcileModelParams = (model: CatalogModel, current: Record<string, unknown>, saved: Record<string, unknown> = {}, options?: Parameters<typeof reconcileForClient>[3]) =>
  reconcileForClient(forClient(model), current, saved, options)
const materializeModelParams = (model: CatalogModel, current: Record<string, unknown>, options?: Parameters<typeof materializeForClient>[2]) =>
  materializeForClient(forClient(model), current, options)

const IMAGE: IncomingRef = { kind: 'image', src: '/media/portrait.png' }
const VIDEO: IncomingRef = { kind: 'video', src: '/media/clip.mp4' }
const AUDIO: IncomingRef = { kind: 'audio', src: '/media/track.mp3' }
const REF_SETS: IncomingRef[][] = [[], [IMAGE], [VIDEO], [AUDIO], [IMAGE, AUDIO], [IMAGE, IMAGE]]

/** Набор референсов, при котором сервер разрешает модель в неё саму. */
function refsLandingOn(model: CatalogModel): IncomingRef[] | null {
  return REF_SETS.find((refs) => effectiveCatalogPreset(model.id, model.kind, refs)?.id === model.id) ?? null
}

/** Значения, которые клиент встречает в жизни: из памяти ручек обеих досок. */
function samples(spec: ParamSpec): unknown[] {
  if (spec.widget === 'select') {
    return (spec.options ?? []).flatMap((option) => (
      /^\d+$/.test(option.value) ? [option.value, Number(option.value)] : [option.value]
    ))
  }
  if (spec.widget === 'boolean') return [true, false]
  if (spec.widget === 'textarea') return [String(spec.default ?? '')]
  const number = spec.min ?? (typeof spec.default === 'number' ? spec.default : 1)
  return [number, String(number)]
}

function activating(spec: ParamSpec, model: CatalogModel): Record<string, unknown> {
  if (!spec.activeWhen) return {}
  const controller = model.params?.find((item) => item.name === spec.activeWhen!.name)
  return controller ? { [controller.name]: spec.activeWhen.values[0] } : {}
}

test('Seedance по картинке с длительностью ЧИСЛОМ из памяти сетевой доски запускается (жалоба 19.10.2026)', () => {
  const variant = CATALOG.find((model) => model.id === 'seedance-2-i2v')!
  // Ровно черновик доски со снимка: 480p, 15 с, звук, высокий битрейт.
  const remembered = { resolution: '480p', duration: 15, generate_audio: true, bitrate_mode: 'high' }
  const state = reconcileModelParams(variant, {}, remembered, { hasMediaRefs: true })
  assert.equal(state.duration, '15', 'длительность приводится к виду поля, а не теряется')
  const sent = materializeModelParams(variant, state, { hasMediaRefs: true, referenceAspectRatio: 0.75 })
  assert.deepEqual(sent, {
    resolution: '480p', duration: '15', aspect_ratio: 'auto', generate_audio: true, bitrate_mode: 'high',
  })
  assert.equal(validateModelParams('seedance-2', 'video', [IMAGE], sent), true)
})

test('строка из памяти своей доски в числовом поле становится числом', () => {
  const spec: ParamSpec = { name: 'duration', label: 'Duration', widget: 'slider', default: 5, min: 1, max: 15, step: 1 }
  const model: CatalogModel = { id: 'cloud-like', name: 'Cloud-like', kind: 'video', endpoint: 'x/y', params: [spec] }
  assert.deepEqual(reconcileModelParams(model, {}, { duration: '12' }), { duration: 12 })
  assert.deepEqual(reconcileModelParams(model, {}, { duration: 'auto' }), {})
  assert.deepEqual(reconcileModelParams(model, {}, { duration: 7.5 }), {}, 'дробь в целом поле сервер отвергнет')
})

test('всё, что клиент готовит к отправке, сервер принимает — для каждой модели каталога', () => {
  let checked = 0
  for (const model of CATALOG) {
    const refs = refsLandingOn(model)
    if (!refs || !validateModelParams(model.id, model.kind, refs, {})) continue
    const hasMediaRefs = refs.length > 0
    for (const spec of model.params ?? []) {
      for (const value of samples(spec)) {
        const current = { ...activating(spec, model), [spec.name]: value }
        const state = reconcileModelParams(model, current, {}, { hasMediaRefs })
        const sent = materializeModelParams(model, state, { hasMediaRefs })
        assert.equal(
          validateModelParams(model.id, model.kind, refs, sent),
          true,
          `${model.id}: ${spec.name}=${JSON.stringify(value)} → ${JSON.stringify(sent)}`,
        )
        checked += 1
      }
    }
  }
  assert.ok(checked > 200, `проверено слишком мало сочетаний: ${checked}`)
})
