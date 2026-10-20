import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { extractProviderPreview } from './extractorPreview.js'

test('yt-dlp thumbnail is normalized to local webp and temporary files are removed', async (t) => {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-extractor-preview-'))
  t.after(() => fs.rm(mediaDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const source = await sharp({
    create: { width: 8, height: 12, channels: 3, background: '#f45b3a' },
  }).png().toBuffer()
  const saved: Buffer[] = []

  const result = await extractProviderPreview({
    provider: 'youtube',
    url: 'https://youtu.be/demo',
    entryId: 'entry',
    mediaDir,
    locate: async () => 'C:/runtime/yt-dlp.exe',
    run: async ({ outputDir }) => {
      await fs.writeFile(path.join(outputDir, 'preview.png'), source)
    },
    savePreview: async (buffer) => {
      saved.push(buffer)
      return '/media/link-preview-entry.webp'
    },
  })

  assert.equal(result, '/media/link-preview-entry.webp')
  assert.equal((await sharp(saved[0]).metadata()).format, 'webp')
  assert.deepEqual(await fs.readdir(mediaDir), [])
})

test('failed extractor leaves no temporary directory and no preview', async (t) => {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-extractor-preview-error-'))
  t.after(() => fs.rm(mediaDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))

  const result = await extractProviderPreview({
    provider: 'youtube',
    url: 'https://youtu.be/private',
    entryId: 'entry',
    mediaDir,
    locate: async () => 'C:/runtime/yt-dlp.exe',
    run: async () => { throw new Error('private video') },
    savePreview: async () => { throw new Error('must not save') },
  })

  assert.equal(result, undefined)
  assert.deepEqual(await fs.readdir(mediaDir), [])
})

test('Vimeo preview uses yt-dlp and leaves only a local webp', async (t) => {
  const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-extractor-vimeo-'))
  t.after(() => fs.rm(mediaDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  const source = await sharp({
    create: { width: 12, height: 7, channels: 3, background: '#3a73f4' },
  }).png().toBuffer()
  const tools: string[] = []
  const saved: Buffer[] = []

  const result = await extractProviderPreview({
    provider: 'vimeo',
    url: 'https://vimeo.com/12345',
    entryId: 'vimeo-entry',
    mediaDir,
    locate: async (tool) => {
      tools.push(tool)
      return `C:/runtime/${tool}.exe`
    },
    run: async ({ outputDir, args }) => {
      assert.equal(args.at(-1), 'https://vimeo.com/12345')
      await fs.writeFile(path.join(outputDir, 'preview.png'), source)
    },
    savePreview: async (buffer) => {
      saved.push(buffer)
      return '/media/link-preview-vimeo-entry.webp'
    },
  })

  assert.equal(result, '/media/link-preview-vimeo-entry.webp')
  assert.deepEqual(tools, ['yt-dlp'])
  assert.equal((await sharp(saved[0]).metadata()).format, 'webp')
  assert.deepEqual(await fs.readdir(mediaDir), [])
})
