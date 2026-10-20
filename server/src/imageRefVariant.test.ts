import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CATALOG, resolveModel, type CatalogModel } from './catalog.js'
import { effectiveCatalogPreset, validateModelRefs } from './modelRefLimits.js'
import type { IncomingRef } from './refs.js'
import { effectiveModel } from '../../client/src/spaces/canvas/effectiveModel.js'
import type { CatalogModel as ClientCatalogModel } from '../../client/src/types.js'

// ⚠️ Аудит моделей 19.10.2026, находка 4. У Seedance 2.0 картинки берут ДВА
// варианта: «первый и последний кадр» (`seedance-2-i2v`, до двух) и «по
// референсам» (`seedance-2-refs`, до девяти). С картинкой всегда включался
// первый, второй — только роликом или звуком, и три картинки получали отказ
// «не больше двух», хотя модель их берёт. Сервер команды такой запуск давно
// уводит «по референсам».
//
// Правило живёт в ДВУХ местах — `effectiveModel` у приложения (цена, ручки,
// согласие) и `resolveModel` у своего сервера (проверка и запуск), — и
// разойтись им нельзя: приложение показало бы одну модель, а запустилась бы
// другая. Поэтому здесь не только примеры, но и перебор всего каталога.

const images = (count: number): IncomingRef[] => Array.from({ length: count }, (_, index) => ({
  kind: 'image', src: `/media/ref-${index}.png`,
}))

const endpointFor = (modelId: string, count: number) =>
  resolveModel(modelId, 'video', count > 0, false, false, count).endpoint

test('Seedance 2.0: две картинки — «кадры», три и больше — «по референсам»', () => {
  assert.equal(endpointFor('seedance-2', 1), 'bytedance/seedance-2.0/image-to-video')
  assert.equal(endpointFor('seedance-2', 2), 'bytedance/seedance-2.0/image-to-video')
  assert.equal(endpointFor('seedance-2', 3), 'bytedance/seedance-2.0/reference-to-video')
  assert.equal(endpointFor('seedance-2', 9), 'bytedance/seedance-2.0/reference-to-video')
  // Приложение присылает номер ВАРИАНТА, который посчитало само: прежнее
  // приложение с тремя картинками пришлёт «кадры» — сервер обязан поправить.
  assert.equal(endpointFor('seedance-2-i2v', 3), 'bytedance/seedance-2.0/reference-to-video')
  // Модель не выбрана — та же лестница от модели по умолчанию.
  assert.equal(resolveModel(undefined, 'video', true, false, false, 3).endpoint, 'bytedance/seedance-2.0/reference-to-video')
  // Без числа — прежнее поведение: одна картинка.
  assert.equal(resolveModel('seedance-2', 'video', true).endpoint, 'bytedance/seedance-2.0/image-to-video')
})

test('Seedance 2.0: проверка перед запуском пропускает три и девять картинок, а десять — нет', () => {
  for (const count of [3, 9]) {
    assert.equal(validateModelRefs('seedance-2', 'video', images(count)), null, `картинок ${count}`)
    assert.equal(effectiveCatalogPreset('seedance-2', 'video', images(count))?.id, 'seedance-2-refs')
  }
  assert.equal(effectiveCatalogPreset('seedance-2', 'video', images(2))?.id, 'seedance-2-i2v')
  assert.match(validateModelRefs('seedance-2', 'video', images(10)) ?? '', /by reference” accepts no more than 9 image/u)
})

test('видео-вариант без картинок не принимает картинки: Grok и Gemini Omni Flash остаются на своих', () => {
  // У Grok «видео-вариант» — правка ролика, картинок он не берёт вовсе.
  assert.equal(endpointFor('grok', 2), 'xai/grok-imagine-video/image-to-video')
  assert.match(validateModelRefs('grok', 'video', images(2)) ?? '', /no more than 1 image/u)
  assert.equal(endpointFor('veo-omni', 11), 'google/gemini-omni-flash/reference-to-video')
})

// Каталог приходит клиенту из GET /api/models: там refs всегда булево.
const forClient = (model: CatalogModel): ClientCatalogModel => ({ ...model, refs: Boolean(model.refs) }) as ClientCatalogModel

test('⚠️ СТОРОЖ: приложение и свой сервер выбирают ОДИН вариант при любом числе картинок', () => {
  const clientModels = CATALOG.map(forClient)
  const mismatches: string[] = []
  for (const model of CATALOG) {
    if (model.kind !== 'image' && model.kind !== 'video') continue
    for (let count = 0; count <= 12; count++) {
      const client = effectiveModel(clientModels, model.kind, model.id, count > 0, false, false, count)?.id
      const server = effectiveCatalogPreset(model.id, model.kind, images(count))?.id
      if (client !== server) mismatches.push(`${model.id}, картинок ${count}: приложение ${client}, сервер ${server}`)
    }
  }
  assert.deepEqual(mismatches, [])
})

test('⚠️ СТОРОЖ: запуск считает варианты тем же правилом, что и проверка', () => {
  // Проверка прошла бы «по референсам», а запуск, не узнав числа картинок,
  // отправил бы три картинки «кадрами» — отказ провайдера уже после запуска.
  const source = fs.readFileSync(new URL('./runner.ts', import.meta.url), 'utf8')
  assert.match(source, /resolveForRefs\(job\.model, job\.kind, prepared\.refs\)/u)
  assert.doesNotMatch(source, /resolveModel\(job\.model/u)
})
