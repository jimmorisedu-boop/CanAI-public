import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { ensureShareImagePreview, previewEdgeStep } from './shareMediaPreview.js'

test('размер превью округляется вверх до одной из ограниченных ступеней', () => {
  assert.equal(previewEdgeStep(1), 256)
  assert.equal(previewEdgeStep(300), 512)
  assert.equal(previewEdgeStep(700), 1024)
  assert.equal(previewEdgeStep(4000), 1920)
  assert.equal(previewEdgeStep(Number.NaN), 1920)
})

test('один оригинал получает разные кэшируемые WebP для разных экранных размеров', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-screen-preview-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const sourceFile = path.join(root, 'source.png')
  const previewDir = path.join(root, 'previews')
  await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: '#f45b3a' },
  }).png().toFile(sourceFile)

  const small = await ensureShareImagePreview({ sourceFile, previewDir, maxEdge: 300 })
  const large = await ensureShareImagePreview({ sourceFile, previewDir, maxEdge: 700 })
  const smallAgain = await ensureShareImagePreview({ sourceFile, previewDir, maxEdge: 300 })

  assert.notEqual(small, large, 'ступень должна входить в имя кэша')
  assert.equal(smallAgain, small, 'одинаковая ступень должна переиспользовать кэш')
  // Sharp на Windows может ещё держать файл при cleanup сразу после metadata().
  // Читаем готовые превью в буферы, чтобы временные файлы не оставались открытыми.
  const smallMetadata = await sharp(await fs.readFile(small)).metadata()
  const largeMetadata = await sharp(await fs.readFile(large)).metadata()
  assert.deepEqual({ width: smallMetadata.width, height: smallMetadata.height }, { width: 512, height: 384 })
  assert.deepEqual({ width: largeMetadata.width, height: largeMetadata.height }, { width: 1024, height: 768 })
})
