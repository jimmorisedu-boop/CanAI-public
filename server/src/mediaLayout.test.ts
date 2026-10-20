import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MEDIA_SHARED_FOLDER,
  MEDIA_TYPE_FOLDERS,
  boardFolderName,
  boardFolderNames,
  mediaFileName,
  mediaPathIn,
  mediaTypeFolder,
  mediaWritePathIn,
  resolveMediaIn,
  sortMediaByBoards,
} from './mediaLayout.js'

async function sandbox(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'canai-media-'))
}

const board = (id: string, name: string, files: string[]) => ({ id, name, files })

test('внутри доски материал разложен по типу', () => {
  assert.equal(mediaTypeFolder('a.png'), MEDIA_TYPE_FOLDERS.image)
  assert.equal(mediaTypeFolder('a.jpeg'), MEDIA_TYPE_FOLDERS.image)
  assert.equal(mediaTypeFolder('a.mp4'), MEDIA_TYPE_FOLDERS.video)
  assert.equal(mediaTypeFolder('a.mp3'), MEDIA_TYPE_FOLDERS.audio)
  assert.equal(mediaTypeFolder('a.opus'), MEDIA_TYPE_FOLDERS.audio, 'расширение-синоним тоже знаем')
  assert.equal(mediaTypeFolder('a.bin'), MEDIA_TYPE_FOLDERS.other)
})

test('имя файла срезает и папки, и ?v=<mtime> внешнего редактора', () => {
  // Без среза расширением становилось бы «png?v=123», и файл уезжал бы в
  // «прочее» вместо картинок.
  assert.equal(mediaFileName('/media/edit-a.png?v=1786012345'), 'edit-a.png')
  assert.equal(mediaTypeFolder('/media/edit-a.png?v=1786012345'), MEDIA_TYPE_FOLDERS.image)
  assert.equal(mediaFileName('/media/../../секрет.png'), 'секрет.png', 'выйти из папки нельзя')
})

test('папка доски называется её именем, а безымянная — по короткому id', () => {
  // Папку открывает человек: «Трейлер» ему говорит больше, чем uuid.
  assert.equal(boardFolderName({ id: 'abc123def', name: 'Трейлер' }), 'Трейлер')
  assert.equal(boardFolderName({ id: 'abc123def', name: 'доска: 1/2' }), 'доска 1 2')
  assert.equal(boardFolderName({ id: 'abc123def', name: '' }), 'board abc123')
})

test('одноимённые доски разъезжаются по разным папкам', () => {
  // Иначе материал двух «Без названия» смешался бы в одной папке — то есть
  // «найти руками» перестало бы работать ровно там, где нужнее всего.
  const folders = boardFolderNames([
    { id: 'aaaaaaaa', name: 'Без названия' },
    { id: 'bbbbbbbb', name: 'Без названия' },
  ])
  assert.equal(folders.get('aaaaaaaa'), 'Без названия')
  assert.equal(folders.get('bbbbbbbb'), 'Без названия (bbbbbb)')
})

test('доску нельзя назвать «общее» и увести туда чужой материал', () => {
  const folders = boardFolderNames([{ id: 'aaaaaaaa', name: MEDIA_SHARED_FOLDER }])
  assert.equal(folders.get('aaaaaaaa'), 'general (aaaaaa)')
})

test('запись идёт в «общее»: доска в этот момент ещё не известна', async () => {
  // Файл сохраняется до того, как объект окажется на холсте, а генерация про
  // доску вообще не знает. Раскладывает потом sortMediaByBoards.
  const root = await sandbox()
  const target = await mediaWritePathIn(root, 'звук.mp3')
  assert.equal(target, path.join(root, MEDIA_SHARED_FOLDER, MEDIA_TYPE_FOLDERS.audio, 'звук.mp3'))
  await fs.writeFile(target, 'x')
  assert.equal(await fs.readFile(target, 'utf8'), 'x')
})

test('файл уезжает к доске, которая на него ссылается', async () => {
  const root = await sandbox()
  const shared = path.join(root, MEDIA_SHARED_FOLDER, MEDIA_TYPE_FOLDERS.image)
  await fs.mkdir(shared, { recursive: true })
  await fs.writeFile(path.join(shared, 'кадр.png'), 'x')

  const result = await sortMediaByBoards({
    root,
    boards: [board('b1', 'Трейлер', ['/media/кадр.png'])],
  })

  assert.equal(result.moved, 1)
  assert.equal(
    await fs.readFile(path.join(root, 'Трейлер', MEDIA_TYPE_FOLDERS.image, 'кадр.png'), 'utf8'),
    'x',
  )
  // и ссылка по-прежнему находит файл — это главное требование
  assert.equal(
    resolveMediaIn(root, '/media/кадр.png'),
    path.join(root, 'Трейлер', MEDIA_TYPE_FOLDERS.image, 'кадр.png'),
  )
})

test('нужный двум доскам остаётся в «общем», а ничей туда возвращается', async () => {
  const root = await sandbox()
  await fs.mkdir(path.join(root, 'Трейлер', MEDIA_TYPE_FOLDERS.image), { recursive: true })
  await fs.writeFile(path.join(root, 'Трейлер', MEDIA_TYPE_FOLDERS.image, 'общий.png'), 'x')
  await fs.writeFile(path.join(root, 'Трейлер', MEDIA_TYPE_FOLDERS.image, 'ничей.png'), 'x')

  await sortMediaByBoards({
    root,
    boards: [
      board('b1', 'Трейлер', ['/media/общий.png']),
      board('b2', 'Свалка', ['/media/общий.png']),
    ],
  })

  const sharedImages = path.join(root, MEDIA_SHARED_FOLDER, MEDIA_TYPE_FOLDERS.image)
  assert.deepEqual((await fs.readdir(sharedImages)).sort(), ['ничей.png', 'общий.png'])
})

test('МИГРАЦИЯ: файлы из корня разъезжаются, и ни один не пропадает', async () => {
  // Прямое требование: при обновлении у клиентов ничего не должно потеряться.
  const root = await sandbox()
  await fs.writeFile(path.join(root, 'старая.png'), '1')
  await fs.writeFile(path.join(root, 'клип.mp4'), '2')
  await fs.writeFile(path.join(root, 'чужая.png'), '3')

  const result = await sortMediaByBoards({
    root,
    boards: [board('b1', 'Свалка', ['/media/старая.png', '/media/клип.mp4'])],
  })

  assert.equal(result.moved, 3)
  assert.equal(await fs.readFile(path.join(root, 'Свалка', MEDIA_TYPE_FOLDERS.image, 'старая.png'), 'utf8'), '1')
  assert.equal(await fs.readFile(path.join(root, 'Свалка', MEDIA_TYPE_FOLDERS.video, 'клип.mp4'), 'utf8'), '2')
  assert.equal(await fs.readFile(path.join(root, MEDIA_SHARED_FOLDER, MEDIA_TYPE_FOLDERS.image, 'чужая.png'), 'utf8'), '3')
  // все три по-прежнему находятся по прежним ссылкам
  for (const name of ['старая.png', 'клип.mp4', 'чужая.png']) {
    assert.equal(await fs.readFile(resolveMediaIn(root, `/media/${name}`), 'utf8').catch(() => null) !== null, true, name)
  }
})

test('повторный проход ничего не двигает', async () => {
  const root = await sandbox()
  await fs.writeFile(path.join(root, 'кадр.png'), 'x')
  const boards = [board('b1', 'Трейлер', ['/media/кадр.png'])]
  assert.equal((await sortMediaByBoards({ root, boards })).moved, 1)
  assert.equal((await sortMediaByBoards({ root, boards })).moved, 0, 'раскладка идемпотентна')
})

test('занятое имя не перетирается', async () => {
  // Чужой файл важнее аккуратности раскладки.
  const root = await sandbox()
  await fs.mkdir(path.join(root, 'Трейлер', MEDIA_TYPE_FOLDERS.image), { recursive: true })
  await fs.writeFile(path.join(root, 'Трейлер', MEDIA_TYPE_FOLDERS.image, 'кадр.png'), 'нужный')
  await fs.writeFile(path.join(root, 'кадр.png'), 'самозванец')

  const result = await sortMediaByBoards({ root, boards: [board('b1', 'Трейлер', ['/media/кадр.png'])] })

  assert.equal(result.skipped, 1)
  assert.equal(
    await fs.readFile(path.join(root, 'Трейлер', MEDIA_TYPE_FOLDERS.image, 'кадр.png'), 'utf8'),
    'нужный',
  )
})

test('пропавший файл указывает на место по раскладке', async () => {
  const root = await sandbox()
  assert.equal(
    resolveMediaIn(root, 'нет.mp4'),
    mediaPathIn(root, 'нет.mp4'),
    'ошибка «не найден» показывает, где искать',
  )
})
