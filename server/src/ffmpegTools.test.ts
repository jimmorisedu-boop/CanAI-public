import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ffmpegSearchPlan, systemFfmpegTools } from './ffmpegTools.js'

async function withDirs(count: number, run: (dirs: string[]) => Promise<void>): Promise<void> {
  const dirs: string[] = []
  for (let index = 0; index < count; index++) {
    dirs.push(await fs.mkdtemp(path.join(os.tmpdir(), 'canai-path-')))
  }
  try {
    await run(dirs)
  } finally {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {})
  }
}

test('оба инструмента берутся из ОДНОЙ папки PATH, а не собираются по кусочкам', async () => {
  await withDirs(2, async ([first, second]) => {
    // Классическая ловушка: ffmpeg в одной папке, ffprobe в другой. Собрать
    // из них пару можно, но версии окажутся разными, а расхождение вылезет
    // потом — на разборе опорных кадров, где его будет уже не связать с PATH.
    await fs.writeFile(path.join(first, 'ffmpeg.exe'), 'x')
    await fs.writeFile(path.join(second, 'ffprobe.exe'), 'x')
    assert.equal(await systemFfmpegTools([first, second].join(';'), 'win32'), null)

    await fs.writeFile(path.join(second, 'ffmpeg.exe'), 'x')
    const tools = await systemFfmpegTools([first, second].join(';'), 'win32')
    assert.equal(tools?.ffmpeg, path.join(second, 'ffmpeg.exe'))
    assert.equal(tools?.ffprobe, path.join(second, 'ffprobe.exe'))
  })
})

test('пустой и мусорный PATH не роняют поиск', async () => {
  // Именно '' и мусор, а не undefined: undefined включает значение по
  // умолчанию, то есть настоящий PATH машины, и тест начинает зависеть от
  // того, что установлено у запускающего.
  assert.equal(await systemFfmpegTools('', 'win32'), null)
  assert.equal(await systemFfmpegTools(';;   ;;', 'win32'), null)
  assert.equal(await systemFfmpegTools('C:\\нет-такой-папки', 'win32'), null)
})

test('разделитель и имена берутся по системе, кавычки вокруг путей снимаются', () => {
  const win = ffmpegSearchPlan('C:\\Tools;"C:\\Program Files\\bin";', 'win32')
  assert.deepEqual(win.directories, ['C:\\Tools', 'C:\\Program Files\\bin'])
  assert.deepEqual(win.names, { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' })

  // На linux разделитель — двоеточие, и по нему нельзя резать windows-пути:
  // «C:\Tools» превратилось бы в «C» и «\Tools». Поэтому системы разведены.
  const nix = ffmpegSearchPlan('/usr/bin:/opt/ffmpeg/bin', 'linux')
  assert.deepEqual(nix.directories, ['/usr/bin', '/opt/ffmpeg/bin'])
  assert.deepEqual(nix.names, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
})
