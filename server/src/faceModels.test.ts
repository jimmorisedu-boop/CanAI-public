import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FACE_MODELS, FaceModels } from './faceModels.js'

// Модели сравнения лиц качаются кнопкой и живут в runtime/, как ffmpeg.
// Проверяем ровно то, что молча ломается: подмену файла, половинчатую
// установку и выход за пределы папки по имени из адреса.

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'canai-face-'))
}

function bodyOf(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(bytes)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
}

test('лицензии моделей — только разрешающие: приложение продаётся', () => {
  // ArcFace/InsightFace отдают веса лишь для некоммерческих исследований.
  // Появится такая строка — значит кто-то принёс модель, которую нельзя
  // класть в проданное приложение (та же история, что с GPL-сборкой ffmpeg).
  for (const model of FACE_MODELS) {
    assert.match(model.license, /^(MIT|Apache 2\.0|BSD)/, `${model.name}: ${model.license}`)
  }
})

test('огрызок вместо модели не принимается за готовую', async () => {
  // По ссылке git-lfs вместо модели легко прилетает текстовый указатель на
  // сотню байт. Без проверки размера он лёг бы под именем модели, и ошибка
  // всплыла бы уже в браузере, при попытке считать сходство.
  const dir = await tempDir()
  const models = new FaceModels({
    runtimeDir: dir,
    fetchAsset: async () => ({ ok: true, status: 200, body: bodyOf(120), size: 120 }),
  })
  await assert.rejects(models.download(), /Instead of model/u)
  assert.equal(models.getState().state, 'failed')
  const left = await fs.readdir(path.join(dir, 'face-models'))
  assert.deepEqual(left, [], 'недокачанного файла остаться не должно')
})

test('нужны ОБЕ модели: без детектора лицо не найти', async () => {
  const dir = await tempDir()
  const modelsDir = path.join(dir, 'face-models')
  await fs.mkdir(modelsDir, { recursive: true })
  // Кладём только вторую, крупную.
  const heavy = FACE_MODELS[1]
  await fs.writeFile(path.join(modelsDir, heavy.name), Buffer.alloc(heavy.minBytes))
  const models = new FaceModels({ runtimeDir: dir })
  assert.equal(await models.locate(), null)
  assert.equal(models.getState().state, 'missing')
})

test('обе на месте — компонент готов', async () => {
  const dir = await tempDir()
  const modelsDir = path.join(dir, 'face-models')
  await fs.mkdir(modelsDir, { recursive: true })
  for (const model of FACE_MODELS) {
    await fs.writeFile(path.join(modelsDir, model.name), Buffer.alloc(model.minBytes))
  }
  const models = new FaceModels({ runtimeDir: dir })
  assert.ok(await models.locate())
  assert.equal(models.getState().state, 'ready')
})

test('имя файла берётся только из своего списка', async () => {
  // Имя приходит из адреса, и собрать по нему путь — значит выпустить
  // запрос за пределы папки.
  const models = new FaceModels({ runtimeDir: await tempDir() })
  assert.equal(models.filePath('../../server/.env'), null)
  assert.equal(models.filePath('face_detection_yunet_2023mar.onnx.part'), null)
  assert.ok(models.filePath(FACE_MODELS[0].name))
})

test('повторная закачка во время идущей не начинает вторую', async () => {
  const dir = await tempDir()
  let calls = 0
  const models = new FaceModels({
    runtimeDir: dir,
    fetchAsset: async (url) => {
      calls++
      const model = FACE_MODELS.find((item) => item.url === url)!
      return { ok: true, status: 200, body: bodyOf(model.minBytes), size: model.minBytes }
    },
  })
  const [first, second] = await Promise.all([models.download(), models.download()])
  assert.equal(first, second)
  assert.equal(calls, FACE_MODELS.length, 'каждая модель скачана ровно один раз')
})
