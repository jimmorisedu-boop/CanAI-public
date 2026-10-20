import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EditorPathError, resolveEditorTarget } from './editorTarget.js'

// ⚠️ Модуль появился потому, что проверка и запуск разъехались: кнопка
// «Проверить» звала fs.access, а он проходит и на ПАПКЕ — «/Applications/…app»
// получал «Программа найдена и доступна», а F2 падал со spawn EACCES. Ложное
// «всё в порядке» хуже честного отказа.

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-editor-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {})
  }
}

/** Похожий на настоящий бандл: каталог .app с Contents/MacOS внутри. */
async function makeBundle(dir: string, name: string, executables: string[]): Promise<string> {
  const bundle = path.join(dir, `${name}.app`)
  const macOs = path.join(bundle, 'Contents', 'MacOS')
  await fs.mkdir(macOs, { recursive: true })
  for (const executable of executables) {
    const file = path.join(macOs, executable)
    await fs.writeFile(file, '#!/bin/sh\n')
    await fs.chmod(file, 0o755)
  }
  return bundle
}

test('обычный исполняемый файл принимается как есть', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'Photoshop.exe')
    await fs.writeFile(file, 'x')
    await fs.chmod(file, 0o755)
    const target = await resolveEditorTarget(file, { platform: 'win32' })
    assert.equal(target.executable, file)
    assert.equal(target.resolvedFrom, null, 'путь не подменялся — сообщать не о чем')
  })
})

// Вот она, та самая ошибка: раньше здесь отвечали «Программа найдена».
test('папка программой не считается — на Windows это прямой отказ', async () => {
  await withTempDir(async (dir) => {
    const folder = path.join(dir, 'Adobe')
    await fs.mkdir(folder)
    await assert.rejects(
      () => resolveEditorTarget(folder, { platform: 'win32' }),
      (error: unknown) => error instanceof EditorPathError && /folder, not an application/.test(error.message),
    )
  })
})

test('на macOS бандл .app разворачивается в файл внутри него', async () => {
  await withTempDir(async (dir) => {
    const bundle = await makeBundle(dir, 'Adobe Photoshop 2025', ['Adobe Photoshop 2025'])
    const target = await resolveEditorTarget(bundle, {
      platform: 'darwin',
      bundleExecutable: async () => 'Adobe Photoshop 2025',
    })
    assert.equal(target.executable, path.join(bundle, 'Contents', 'MacOS', 'Adobe Photoshop 2025'))
    assert.equal(target.resolvedFrom, bundle, 'человеку стоит сказать, что запустится не то, что он вписал')
  })
})

test('Info.plist врёт или отсутствует — берём единственный исполняемый файл', async () => {
  await withTempDir(async (dir) => {
    const bundle = await makeBundle(dir, 'Krita', ['krita'])
    const target = await resolveEditorTarget(bundle, {
      platform: 'darwin',
      bundleExecutable: async () => null,
    })
    assert.equal(target.executable, path.join(bundle, 'Contents', 'MacOS', 'krita'))
  })
})

test('пустой бандл отказывает словами, а не падает', async () => {
  await withTempDir(async (dir) => {
    const bundle = await makeBundle(dir, 'Пустая', [])
    await assert.rejects(
      () => resolveEditorTarget(bundle, { platform: 'darwin', bundleExecutable: async () => null }),
      (error: unknown) => error instanceof EditorPathError && /contains no executable file/.test(error.message),
    )
  })
})

test('несколько исполняемых файлов — просим уточнить, а не гадаем', async () => {
  await withTempDir(async (dir) => {
    const bundle = await makeBundle(dir, 'Двойная', ['one', 'two'])
    await assert.rejects(
      () => resolveEditorTarget(bundle, { platform: 'darwin', bundleExecutable: async () => null }),
      (error: unknown) => error instanceof EditorPathError && /contains multiple executable files/.test(error.message),
    )
  })
})

test('несуществующий путь называет себя', async () => {
  await assert.rejects(
    () => resolveEditorTarget(path.join(os.tmpdir(), 'canai-нет-такой-программы'), { platform: 'darwin' }),
    (error: unknown) => error instanceof EditorPathError && /File not found/.test(error.message),
  )
})

test('пустая строка — понятный отказ', async () => {
  await assert.rejects(
    () => resolveEditorTarget('   ', { platform: 'darwin' }),
    (error: unknown) => error instanceof EditorPathError && /Provide the application path/.test(error.message),
  )
})

// Право на исполнение проверяем только там, где оно есть: на Windows файловая
// система его не хранит, и fs.access(X_OK) там равносилен «файл существует».
test('файл без права на исполнение не выдаётся за программу', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'readme.txt')
    await fs.writeFile(file, 'x')
    await fs.chmod(file, 0o644)
    await assert.rejects(
      () => resolveEditorTarget(file, { platform: 'darwin' }),
      (error: unknown) => error instanceof EditorPathError && /права на исполнение/.test(error.message),
    )
  })
})
