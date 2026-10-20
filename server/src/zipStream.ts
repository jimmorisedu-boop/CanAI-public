import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import type { Readable } from 'node:stream'

// Минимальный потоковый ZIP (метод STORE, без сжатия). Раньше экспорт
// публикации собирал AdmZip'ом ВСЕ media в память — доска с парой больших
// видео роняла процесс по запросу гостя. Формат пишем вручную: локальные
// заголовки → центральный каталог → EOCD. Media и так сжатые (PNG/MP4),
// STORE не раздувает архив. Предел формата — 4 ГБ, дальше нужен zip64.

export type ZipSink = (chunk: Buffer) => Promise<void>

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

class Crc32 {
  private value = 0xffffffff
  update(chunk: Buffer): void {
    let c = this.value
    for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
    this.value = c
  }
  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0
  }
}

interface ZipEntry {
  name: Buffer
  crc: number
  size: number
  offset: number
  time: number
  date: number
}

function dosDateTime(timestamp: number): { time: number; date: number } {
  const d = new Date(timestamp)
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export class ZipWriter {
  private offset = 0
  private readonly entries: ZipEntry[] = []

  constructor(private readonly sink: ZipSink) {}

  private async write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length
    await this.sink(chunk)
  }

  async addBuffer(name: string, data: Buffer, timestamp = Date.now()): Promise<void> {
    const crc = new Crc32()
    crc.update(data)
    await this.writeEntryHeader(name, crc.digest(), data.length, timestamp)
    await this.write(data)
  }

  async addFile(name: string, filePath: string, timestamp = Date.now()): Promise<void> {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error(`Not file: ${filePath}`)
    if (stat.size >= 0xffffffff) throw new Error('Publication larger than 4 GB does not fit in ZIP')
    // CRC нужен в заголовке ДО данных: первый проход считает контрольную
    // сумму, второй — стримит содержимое. Локальный диск, память O(чанка).
    const crc = new Crc32()
    for await (const chunk of createReadStream(filePath)) {
      crc.update(chunk as Buffer)
    }
    await this.writeEntryHeader(name, crc.digest(), stat.size, timestamp)
    await pipelineTo(createReadStream(filePath), this.write.bind(this))
  }

  private async writeEntryHeader(name: string, crc: number, size: number, timestamp: number): Promise<void> {
    const nameBytes = Buffer.from(name, 'utf8')
    if (nameBytes.length > 0xffff) throw new Error('File name is too long for ZIP')
    const { time, date } = dosDateTime(timestamp)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // версия
    header.writeUInt16LE(0, 6) // флаги
    header.writeUInt16LE(0, 8) // метод STORE
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(size, 18)
    header.writeUInt32LE(size, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    this.entries.push({ name: nameBytes, crc, size, offset: this.offset, time, date })
    await this.write(header)
    await this.write(nameBytes)
  }

  async finish(): Promise<void> {
    const centralStart = this.offset
    for (const entry of this.entries) {
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(20, 4) // версия создателя
      record.writeUInt16LE(20, 6) // версия нужна
      record.writeUInt16LE(0, 8)
      record.writeUInt16LE(0, 10)
      record.writeUInt16LE(entry.time, 12)
      record.writeUInt16LE(entry.date, 14)
      record.writeUInt32LE(entry.crc, 16)
      record.writeUInt32LE(entry.size, 20)
      record.writeUInt32LE(entry.size, 24)
      record.writeUInt16LE(entry.name.length, 28)
      record.writeUInt32LE(entry.offset, 42)
      await this.write(record)
      await this.write(entry.name)
    }
    const centralSize = this.offset - centralStart
    if (centralStart + centralSize >= 0xffffffff) throw new Error('Publication larger than 4 GB does not fit in ZIP')
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(this.entries.length, 8)
    eocd.writeUInt16LE(this.entries.length, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(centralStart, 16)
    await this.write(eocd)
  }
}

async function pipelineTo(source: Readable, write: (chunk: Buffer) => Promise<void>): Promise<void> {
  for await (const chunk of source) {
    await write(chunk as Buffer)
  }
}
