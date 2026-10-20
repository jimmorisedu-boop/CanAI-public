import express from 'express'
import path from 'node:path'
import { config } from './config.js'
import { ensureShareImagePreview, previewEdgeStep } from './shareMediaPreview.js'
import { mediaFilePathAsync } from './storage.js'

// Раздача media одинакова для основного сервера и для планшетного: файл ищется
// по ИМЕНИ (в ссылках досок лежит «/media/<имя>» без папки — переписывать их
// ради вида на диске нельзя), отдаётся навсегда закэшированным, а SVG — в
// песочнице, иначе он умеет исполнять скрипты.
export function attachMediaRoutes(app: express.Express): void {
  /**
   * Экранное превью картинки с доски.
   *
   * ⚠️ Холст рисует растры каждый кадр движения камеры, и браузер каждый раз
   * ужимает их заново. Замер на доске пользователя (24 картинки по 5,9 Мпикс,
   * масштаб 0.29): кадр из оригиналов — 78 мс, первый вообще 942 мс; из
   * уменьшенных копий — 0,03 мс. Отсюда и «фризы при передвижении»
   * (жалоба 07.09.2026): при 60 кадрах в секунду на кадр есть 16 мс.
   *
   * Ссылки в досках при этом не меняются: `item.src` остаётся оригиналом, а
   * превью просит сам холст (см. konva/screenPreview). Не вышло — отправляем
   * к оригиналу, дыры на месте картинки не будет.
   */
  app.get('/media/preview/:name', async (req, res) => {
    const name = path.basename(req.params.name)
    const maxEdge = previewEdgeStep(Number(req.query.w))
    try {
      const sourceFile = await mediaFilePathAsync(name)
      const previewFile = await ensureShareImagePreview({
        sourceFile,
        previewDir: path.join(config.mediaDir, '..', 'screen-previews'),
        maxEdge,
      })
      res.type('image/webp')
      res.setHeader('cache-control', 'private, max-age=31536000, immutable')
      res.setHeader('x-content-type-options', 'nosniff')
      res.sendFile(path.resolve(previewFile))
    } catch {
      res.redirect(302, `/media/${encodeURIComponent(name)}`)
    }
  })

  app.get('/media/:name', async (req, res) => {
    const name = path.basename(req.params.name)
    let file: string
    try {
      file = await mediaFilePathAsync(name)
    } catch {
      res.status(404).send('Media not found')
      return
    }
    res.sendFile(file, {
      maxAge: '365d',
      immutable: true,
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        ...(path.extname(file).toLowerCase() === '.svg'
          ? { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" }
          : {}),
      },
    }, (err) => {
      if (!err) return
      if (!res.headersSent) res.status(404).send('Media not found')
    })
  })
  app.use('/media', (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && (err.code === 'ENOENT' || err.status === 404)) {
      return res.status(404).send('Media not found')
    }
    next(err)
  })
}
