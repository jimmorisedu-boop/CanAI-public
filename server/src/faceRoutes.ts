import { Router } from 'express'
import { config } from './config.js'
import { FACE_MODELS, FaceModels, type FaceModelsState } from './faceModels.js'

// Модели сравнения лиц: состояние, загрузка по кнопке и отдача файлов браузеру.
//
// Считает КЛИЕНТ (onnxruntime-web), поэтому сервер здесь — только кладовка.
// Загрузка не висит на запросе: 38 МБ дольше, чем живёт HTTP, а человеку нужен
// живой процент. POST запускает, GET отдаёт прогресс — тот же приём, что у
// портативного ffmpeg.

export const faceModels = new FaceModels({ runtimeDir: config.runtimeDir })

export interface PublicFaceModelsState {
  state: FaceModelsState['state']
  percent?: number
  message?: string
  /** Имена файлов и лицензии: показываем в настройках, чтобы было видно, что
   *  качается и на каких условиях. */
  models: Array<{ name: string; license: string }>
}

export function publicFaceModelsState(state: FaceModelsState): PublicFaceModelsState {
  const models = FACE_MODELS.map((model) => ({ name: model.name, license: model.license }))
  if (state.state === 'downloading') return { state: 'downloading', percent: state.percent, models }
  if (state.state === 'failed') return { state: 'failed', message: state.message, models }
  return { state: state.state, models }
}

export function createFaceRouter(models: FaceModels = faceModels): Router {
  const router = Router()

  router.get('/face-models', async (_req, res) => {
    // locate() не трогает состояние идущей закачки — можно опрашивать во время неё
    await models.locate()
    res.json(publicFaceModelsState(models.getState()))
  })

  router.post('/face-models/prepare', async (_req, res) => {
    await models.locate()
    const state = models.getState()
    if (state.state === 'ready' || state.state === 'downloading') {
      return res.json(publicFaceModelsState(state))
    }
    // Отказ ловим здесь же: иначе падение уехало бы в unhandledRejection, а
    // человек остался бы смотреть на «качается».
    models.download().catch(() => undefined)
    res.json(publicFaceModelsState(models.getState()))
  })

  // Файл модели для браузера. Имя приходит из адреса, поэтому берём его ТОЛЬКО
  // из своего списка: собрать путь из пользовательской строки — это выход за
  // пределы папки.
  router.get('/face-models/file/:name', async (req, res) => {
    const file = models.filePath(req.params.name)
    if (!file) return res.status(404).json({ error: 'No such model' })
    if (!(await models.locate())) {
      return res.status(409).json({ error: 'Models still not downloaded' })
    }
    res.type('application/octet-stream')
    // Модель неизменна — пусть браузер держит её у себя и не тянет каждый раз.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.sendFile(file)
  })

  return router
}
