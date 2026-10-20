// @ts-expect-error Клиентские тесты запускаются через tsx с Node-типами.
import assert from 'node:assert/strict'
// @ts-expect-error Production-клиент не зависит от Node-типов.
import test from 'node:test'
import { exportEntryPath, exportFileName, exportFolderFor, safeExportBoardName } from './exportNaming.js'

test('имя файла — метка, номер и название доски', () => {
  assert.equal(
    exportFileName({ mark: 1, number: 1, board: 'моя свалка', extension: 'png' }),
    '1-1_моя свалка.png',
  )
  assert.equal(
    exportFileName({ mark: 2, number: 7, board: 'моя свалка', extension: 'mp4' }),
    '2-7_моя свалка.mp4',
  )
})

test('нумерация продолжается, а не начинается заново', () => {
  // Номера приходят с сервера: он их выдал и запомнил. Второй экспорт той же
  // метки получает 4, 5, 6 — двух «1-1_моя свалка.png» не появится.
  const второйЭкспорт = [4, 5, 6].map((number) => (
    exportFileName({ mark: 1, number, board: 'моя свалка', extension: 'png' })
  ))
  assert.deepEqual(второйЭкспорт, [
    '1-4_моя свалка.png',
    '1-5_моя свалка.png',
    '1-6_моя свалка.png',
  ])
})

test('каждый тип материала — в свою папку', () => {
  assert.equal(exportFolderFor('image'), 'Images')
  assert.equal(exportFolderFor('video'), 'Video')
  assert.equal(exportFolderFor('audio'), 'Audio')
  assert.equal(exportFolderFor('text'), 'Text')
})

test('путь в архиве складывается из папки типа и имени', () => {
  assert.equal(
    exportEntryPath({ kind: 'video', mark: 3, number: 2, board: 'трейлер', extension: 'mp4' }),
    'Video/3-2_трейлер.mp4',
  )
  assert.equal(
    exportEntryPath({ kind: 'audio', mark: 1, number: 12, board: 'трейлер', extension: 'mp3' }),
    'Audio/1-12_трейлер.mp3',
  )
})

test('символы, запрещённые в именах файлов, не доходят до архива', () => {
  // Windows не создаст файл с \\/:*?"<>|, а имя доски пользователь пишет как хочет.
  assert.equal(safeExportBoardName('доска: 1/2'), 'доска 1 2')
  assert.equal(
    exportEntryPath({ kind: 'image', mark: 1, number: 1, board: 'а/б', extension: 'png' }),
    'Images/1-1_а б.png',
  )
})

test('доска без имени всё равно получает имя', () => {
  assert.equal(safeExportBoardName(''), 'board')
  assert.equal(
    exportFileName({ mark: 1, number: 1, board: '   ', extension: 'png' }),
    '1-1_board.png',
  )
})
