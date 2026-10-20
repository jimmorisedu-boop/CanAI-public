import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { FfmpegBinary, ffmpegDownloadUrl, ffmpegPlatform } from './ffmpegBinary.js'

function zipWith(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const body = deflateRawSync(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(Buffer.concat([local, name, body]))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, name]))
    offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

function assetResponse(zip: Buffer) {
  return async () => ({
    ok: true,
    status: 200,
    size: zip.length,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        // Двумя кусками — чтобы прогресс считался по-настоящему, а не одним шагом
        controller.enqueue(new Uint8Array(zip.subarray(0, Math.floor(zip.length / 2))))
        controller.enqueue(new Uint8Array(zip.subarray(Math.floor(zip.length / 2))))
        controller.close()
      },
    }),
  })
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-ffmpeg-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }).catch(() => {})
  }
}

const WIN = () => ffmpegPlatform('win32', 'x64')

test('качаем именно LGPL-сборку — GPL нельзя класть в проданное приложение', () => {
  const platform = WIN()
  assert.ok(platform)
  assert.ok(platform.asset, 'на Windows сборка качается, значит имя архива обязано быть')
  assert.match(platform.asset, /-lgpl\.zip$/)
  assert.equal(ffmpegDownloadUrl(platform), `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${platform.asset}`)
})

test('архив распаковывается в runtime/ и оба инструмента становятся готовы', async () => {
  await withTempDir(async (dir) => {
    const zip = zipWith([
      { name: 'ffmpeg-n7.1-win64-lgpl/README.txt', data: Buffer.from('readme') },
      { name: 'ffmpeg-n7.1-win64-lgpl/bin/ffmpeg.exe', data: Buffer.from('ffmpeg-binary') },
      { name: 'ffmpeg-n7.1-win64-lgpl/bin/ffprobe.exe', data: Buffer.from('ffprobe-binary') },
    ])
    const binary = new FfmpegBinary({ runtimeDir: dir, platform: WIN, fetchAsset: assetResponse(zip) })

    assert.equal(await binary.locate(), null)
    assert.deepEqual(binary.getState(), { state: 'missing' })

    const tools = await binary.download()
    assert.equal(await fs.readFile(tools.ffmpeg, 'utf8'), 'ffmpeg-binary')
    assert.equal(await fs.readFile(tools.ffprobe, 'utf8'), 'ffprobe-binary')
    assert.equal(binary.getState().state, 'ready')

    // Второй запуск приложения находит уже скачанное, не выходя в сеть
    const next = new FfmpegBinary({
      runtimeDir: dir,
      platform: WIN,
      fetchAsset: async () => { throw new Error('сеть трогать нельзя') },
    })
    assert.deepEqual(await next.locate(), tools)
    const reused = next.getState()
    assert.equal(reused.state === 'ready' ? reused.source : null, 'runtime')
    // Временных .part-файлов после успешной распаковки остаться не должно
    assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.part')), [])
  })
})

test('одного ffmpeg без ffprobe недостаточно — иначе половина операций угадывает', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'ffmpeg.exe'), 'только он')
    const binary = new FfmpegBinary({ runtimeDir: dir, platform: WIN, fetchAsset: async () => { throw new Error('нет') } })
    assert.equal(await binary.locate(), null)
    assert.deepEqual(binary.getState(), { state: 'missing' })
  })
})

test('системный ffmpeg подхватывается, но своя копия важнее', async () => {
  await withTempDir(async (dir) => {
    const system = { ffmpeg: 'C:/WINDOWS/ffmpeg.exe', ffprobe: 'C:/WINDOWS/ffprobe.exe' }
    const withSystem = new FfmpegBinary({ runtimeDir: dir, platform: WIN, systemTools: async () => system })
    assert.deepEqual(await withSystem.locate(), system)
    const found = withSystem.getState()
    assert.equal(found.state === 'ready' ? found.source : null, 'system')

    await fs.writeFile(path.join(dir, 'ffmpeg.exe'), 'свой')
    await fs.writeFile(path.join(dir, 'ffprobe.exe'), 'свой')
    const preferLocal = new FfmpegBinary({ runtimeDir: dir, platform: WIN, systemTools: async () => system })
    const tools = await preferLocal.locate()
    assert.equal(tools?.ffmpeg, path.join(dir, 'ffmpeg.exe'))
  })
})

test('неполный архив не оставляет полуготовый runtime', async () => {
  await withTempDir(async (dir) => {
    const zip = zipWith([{ name: 'build/bin/ffmpeg.exe', data: Buffer.from('только ffmpeg') }])
    const binary = new FfmpegBinary({ runtimeDir: dir, platform: WIN, fetchAsset: assetResponse(zip) })
    await assert.rejects(() => binary.download(), /no file ffprobe\.exe/u)
    assert.equal(binary.getState().state, 'failed')
    // Ни одного файла не записано: ffmpeg без ffprobe хуже, чем ничего —
    // при следующем старте он бы сошёл за наполовину рабочую установку.
    assert.deepEqual(await fs.readdir(dir), [])
  })
})

test('опрос состояния не сбивает идущую закачку', async () => {
  await withTempDir(async (dir) => {
    // На машине, где ffmpeg уже стоит в системе, каждый опрос перебивал бы
    // «качается 40%» на «готов, системный», и процент пропадал бы на глазах.
    const system = { ffmpeg: 'C:/WINDOWS/ffmpeg.exe', ffprobe: 'C:/WINDOWS/ffprobe.exe' }
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const binary = new FfmpegBinary({
      runtimeDir: dir,
      platform: WIN,
      systemTools: async () => system,
      fetchAsset: async () => {
        await held
        return { ok: false, status: 500, size: null, body: null }
      },
    })

    const pending = binary.download().catch(() => undefined)
    assert.equal(binary.getState().state, 'downloading')

    // Системный ffmpeg находится, путь возвращается — но состояние прежнее
    assert.deepEqual(await binary.locate(), system)
    assert.equal(binary.getState().state, 'downloading')

    release()
    await pending
  })
})

test('две параллельные загрузки — одна закачка', async () => {
  await withTempDir(async (dir) => {
    const zip = zipWith([
      { name: 'bin/ffmpeg.exe', data: Buffer.from('a') },
      { name: 'bin/ffprobe.exe', data: Buffer.from('b') },
    ])
    let calls = 0
    const binary = new FfmpegBinary({
      runtimeDir: dir,
      platform: WIN,
      fetchAsset: async () => {
        calls++
        return assetResponse(zip)()
      },
    })
    const [first, second] = await Promise.all([binary.download(), binary.download()])
    assert.equal(calls, 1)
    assert.deepEqual(first, second)
  })
})

test('неподдержанная система говорит об этом, а не молчит', async () => {
  await withTempDir(async (dir) => {
    // Не darwin: у macOS теперь СВОЯ ветка (см. ниже). Берём систему, для
    // которой сборки действительно нет ниоткуда.
    assert.equal(ffmpegPlatform('freebsd' as NodeJS.Platform, 'x64'), null)
    const binary = new FfmpegBinary({ runtimeDir: dir, platform: () => ffmpegPlatform('freebsd' as NodeJS.Platform, 'x64') })
    assert.equal(await binary.locate(), null)
    assert.deepEqual(binary.getState(), { state: 'unsupported' })
    await assert.rejects(() => binary.download(), /No bundled ffmpeg build/u)
  })
})

// ⚠️ Этот тест раньше утверждал `ffmpegPlatform('darwin') === null` — то есть
// закреплял ровно ту ошибку, из-за которой на маке не работал ВЕСЬ таймлайн:
// `locate` выходит на неизвестной платформе ДО того, как заглянет в runtime/,
// и своей же сборки, лежащей в папке, приложение не видело.
test('macOS знает свои имена файлов, хотя качать сборку неоткуда', async () => {
  const mac = ffmpegPlatform('darwin', 'arm64')
  assert.ok(mac, 'macOS обязан быть известной платформой')
  assert.equal(mac.asset, null, 'сборку кладём в поставку, а не качаем')
  assert.deepEqual(mac.binaries, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  assert.throws(() => ffmpegDownloadUrl(mac), /bundled with the app; it is not downloaded/u)
})

test('на macOS положенная в папку сборка НАХОДИТСЯ, а кнопка не врёт', async () => {
  await withTempDir(async (dir) => {
    const binary = new FfmpegBinary({ runtimeDir: dir, platform: () => ffmpegPlatform('darwin', 'arm64') })
    // Пока файлов нет — «не хватает», но качать нечего.
    assert.equal(await binary.locate(), null)
    await assert.rejects(() => binary.download(), /bundled with the app; there is nowhere to download it from/u)

    await fs.writeFile(path.join(dir, 'ffmpeg'), 'x')
    await fs.writeFile(path.join(dir, 'ffprobe'), 'x')
    const found = await binary.locate()
    assert.ok(found, 'сборка в папке обязана находиться')
    assert.equal(binary.getState().state, 'ready')
  })
})

test('Windows-ветка не изменилась: архив тот же и качается как раньше', () => {
  const win = ffmpegPlatform('win32', 'x64')
  assert.ok(win)
  assert.equal(win.asset, 'ffmpeg-master-latest-win64-lgpl.zip')
  assert.deepEqual(win.binaries, { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' })
  const linux = ffmpegPlatform('linux', 'x64')
  assert.equal(linux?.asset, 'ffmpeg-master-latest-linux64-lgpl.tar.xz')
})
