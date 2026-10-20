import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Уборка media после раскладки по папкам: она обязана ЗАХОДИТЬ в папки, иначе
// бесхозные файлы копились бы там вечно, а раньше собирались в корне.
//
// Данные готовим в своей папке и подсовываем её через CANAI_DATA_DIR ДО
// импорта gc: config читает переменную один раз при загрузке модуля.

async function prepare(): Promise<{ dataDir: string; media: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-gc-'))
  const media = path.join(dataDir, 'media')
  await fs.mkdir(path.join(media, 'Свалка', 'картинки'), { recursive: true })
  await fs.mkdir(path.join(media, 'Свалка/видео'), { recursive: true })

  // Имена реальных файлов всегда ASCII (uuid), и это важно: ссылки в JSON
  // ищутся регэкспом по ASCII-именам.
  await fs.writeFile(path.join(media, 'Свалка/картинки', 'keep-me.png'), 'x')
  await fs.writeFile(path.join(media, 'Свалка/картинки', 'drop-me.png'), 'x')
  await fs.writeFile(path.join(media, 'Свалка/видео', 'drop-me.mp4'), 'x')
  // файл, оставшийся в корне с времён до раскладки
  await fs.writeFile(path.join(media, 'legacy-keep.png'), 'x')

  const projectId = 'board-1'
  await fs.mkdir(path.join(dataDir, 'projects', projectId), { recursive: true })
  await fs.writeFile(path.join(dataDir, 'projects.json'), JSON.stringify([{
    id: projectId,
    name: 'доска',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
  }]))
  await fs.writeFile(path.join(dataDir, 'projects', projectId, 'project.json'), JSON.stringify({
    version: 1,
    items: [
      { id: 'a', kind: 'image', src: '/media/keep-me.png', x: 0, y: 0, w: 10, h: 10, rotation: 0 },
      { id: 'b', kind: 'image', src: '/media/legacy-keep.png', x: 0, y: 0, w: 10, h: 10, rotation: 0 },
    ],
    camera: { x: 0, y: 0, scale: 1 },
  }))
  return { dataDir, media }
}

test('уборка заходит в папки раскладки и щадит то, на что ссылается доска', async () => {
  const { dataDir, media } = await prepare()
  process.env.CANAI_DATA_DIR = dataDir
  const { gcMedia } = await import('./gc.js')

  const result = await gcMedia(0)

  const list = async (folder: string): Promise<string[]> => (
    (await fs.readdir(path.join(media, folder)).catch(() => [])).sort()
  )
  assert.deepEqual(await list('Свалка/картинки'), ['keep-me.png'], 'бесхозная картинка убрана, нужная осталась')
  assert.deepEqual(await list('Свалка/видео'), [], 'бесхозное видео убрано из своей папки')
  // Файл, оставшийся в корне, тоже проверяется по имени: старые ссылки живы.
  assert.ok((await fs.readdir(media)).includes('legacy-keep.png'), 'файл из корня не тронут')
  assert.equal(result.removed, 2)
  assert.equal(result.kept, 2)

  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})
