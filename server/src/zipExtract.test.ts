import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { extractByBaseName, listZipEntries, readZipEntry } from './zipExtract.js'

// Собираем настоящий ZIP байт за байтом: тест обязан проверять формат, а не
// нашу же обёртку над чужой библиотекой.
function buildZip(files: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const body = file.store ? file.data : deflateRawSync(file.data)
    const method = file.store ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(Buffer.concat([local, name, body]))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
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

test('сжатые и несжатые файлы читаются одинаково', () => {
  const text = Buffer.from('ffmpeg version n7.1 '.repeat(200), 'utf8')
  const zip = buildZip([
    { name: 'build/bin/ffmpeg.exe', data: text },
    { name: 'build/bin/ffprobe.exe', data: Buffer.from([1, 2, 3, 4, 5]), store: true },
  ])

  const entries = listZipEntries(zip)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((e) => e.name), ['build/bin/ffmpeg.exe', 'build/bin/ffprobe.exe'])
  assert.deepEqual(readZipEntry(zip, entries[0]), text)
  assert.deepEqual(readZipEntry(zip, entries[1]), Buffer.from([1, 2, 3, 4, 5]))
})

test('файлы достаются по имени, а не по пути с версией сборки', () => {
  // В архивах ffmpeg всё лежит внутри папки вида ffmpeg-n7.1-win64-lgpl,
  // и знать её имя заранее нельзя — иначе обновление сборки ломает загрузку.
  const zip = buildZip([
    { name: 'ffmpeg-n7.1-win64-lgpl/README.txt', data: Buffer.from('readme') },
    { name: 'ffmpeg-n7.1-win64-lgpl/bin/ffmpeg.exe', data: Buffer.from('binary-a') },
    { name: 'ffmpeg-n7.1-win64-lgpl/bin/ffprobe.exe', data: Buffer.from('binary-b') },
    { name: 'ffmpeg-n7.1-win64-lgpl/bin/ffplay.exe', data: Buffer.from('лишний') },
  ])

  const found = extractByBaseName(zip, ['ffmpeg.exe', 'ffprobe.exe'])
  assert.deepEqual([...found.keys()].sort(), ['ffmpeg.exe', 'ffprobe.exe'])
  assert.equal(found.get('ffmpeg.exe')?.toString(), 'binary-a')
  assert.equal(found.get('ffprobe.exe')?.toString(), 'binary-b')
})

test('чего не понимаем — отказ с текстом, а не молча кривой файл', () => {
  const zip = buildZip([{ name: 'bin/ffmpeg.exe', data: Buffer.from('данные') }])

  assert.throws(() => listZipEntries(Buffer.from('это вообще не архив')), /end-of-central-directory/u)

  const encrypted = Buffer.from(zip)
  const directoryStart = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  encrypted.writeUInt16LE(0x0001, directoryStart + 8)
  assert.throws(() => listZipEntries(encrypted), /Encrypted archives/u)

  const unknownMethod = Buffer.from(zip)
  unknownMethod.writeUInt16LE(99, directoryStart + 10)
  const entry = listZipEntries(unknownMethod)[0]
  assert.throws(() => readZipEntry(unknownMethod, entry), /Unknown compression method/u)
})

test('обрезанный архив не отдаёт огрызок как готовый файл', () => {
  const zip = buildZip([{ name: 'bin/ffmpeg.exe', data: Buffer.from('x'.repeat(500)) }])
  const entries = listZipEntries(zip)
  // Отрезаем хвост данных, оставив каталог на месте: без сверки длины
  // распаковалось бы «что-то», и это «что-то» уехало бы в runtime/.
  const truncated = Buffer.concat([zip.subarray(0, 40), zip.subarray(zip.length - 100)])
  assert.throws(() => readZipEntry(truncated, entries[0]), /archive is corrupted/u)
})
