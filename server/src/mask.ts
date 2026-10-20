import fs from 'node:fs'
import zlib from 'node:zlib'

// Определяем размеры (ширину и высоту) PNG/JPEG буфера
export function getImageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (!buf || buf.length < 8) return null
  // PNG
  if (buf.toString('hex', 0, 8) === '89504e470d0a1a0a' && buf.length >= 24) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    }
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset < buf.length - 8) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]
      if (marker === 0xc0 || marker === 0xc2) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        }
      }
      const len = buf.readUInt16BE(offset + 2)
      offset += 2 + len
    }
  }
  return null
}

// Чистая бинаризация PNG-маски в 100% черно-белые пиксели (0,0,0) и (255,255,255)
// с опциональным масштабированием до targetWidth x targetHeight
export function binarizePngMask(
  pngBuffer: Buffer,
  threshold = 128,
  targetWidth?: number,
  targetHeight?: number,
): Buffer {
  // 1. Проверяем сигнатуру PNG
  if (pngBuffer.length < 8 || pngBuffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    return pngBuffer
  }

  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6 // RGBA by default
  const idatBuffers: Buffer[] = []

  let offset = 8
  while (offset < pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset)
    const type = pngBuffer.toString('ascii', offset + 4, offset + 8)
    const data = pngBuffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idatBuffers.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  if (width === 0 || height === 0 || idatBuffers.length === 0) {
    return pngBuffer
  }

  // Разархивируем данные IDAT
  const compressed = Buffer.concat(idatBuffers)
  let decompressed: Buffer
  try {
    decompressed = zlib.inflateSync(compressed)
  } catch {
    return pngBuffer
  }

  let bytesPerPixel = 4
  if (colorType === 0) bytesPerPixel = 1 // Grayscale
  else if (colorType === 2) bytesPerPixel = 3 // RGB
  else if (colorType === 4) bytesPerPixel = 2 // Grayscale + Alpha
  else if (colorType === 6) bytesPerPixel = 4 // RGBA

  const stride = 1 + width * bytesPerPixel
  if (decompressed.length < height * stride) {
    return pngBuffer
  }

  // Дефильтрация и бинаризация в RGBA (ColorType 6)
  const rawPixelData = Buffer.alloc(height * width * 4)

  const prevRow = Buffer.alloc(width * bytesPerPixel)
  const currRow = Buffer.alloc(width * bytesPerPixel)

  function paeth(a: number, b: number, c: number): number {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    if (pa <= pb && pa <= pc) return a
    if (pb <= pc) return b
    return c
  }

  for (let y = 0; y < height; y++) {
    const lineStart = y * stride
    const filterType = decompressed[lineStart]
    const lineData = decompressed.subarray(lineStart + 1, lineStart + stride)

    for (let i = 0; i < lineData.length; i++) {
      const x = lineData[i]
      const left = i >= bytesPerPixel ? currRow[i - bytesPerPixel] : 0
      const up = prevRow[i]
      const upLeft = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0

      let val = x
      if (filterType === 1) val = (x + left) & 0xff
      else if (filterType === 2) val = (x + up) & 0xff
      else if (filterType === 3) val = (x + Math.floor((left + up) / 2)) & 0xff
      else if (filterType === 4) val = (x + paeth(left, up, upLeft)) & 0xff

      currRow[i] = val
    }

    currRow.copy(prevRow)

    // Применяем бинаризацию по пикселям
    for (let x = 0; x < width; x++) {
      const srcIdx = x * bytesPerPixel
      const dstIdx = (y * width + x) * 4

      let r = 0, g = 0, b = 0, a = 255
      if (colorType === 6) {
        r = currRow[srcIdx]
        g = currRow[srcIdx + 1]
        b = currRow[srcIdx + 2]
        a = currRow[srcIdx + 3]
      } else if (colorType === 2) {
        r = currRow[srcIdx]
        g = currRow[srcIdx + 1]
        b = currRow[srcIdx + 2]
      } else if (colorType === 0) {
        r = g = b = currRow[srcIdx]
      } else if (colorType === 4) {
        r = g = b = currRow[srcIdx]
        a = currRow[srcIdx + 1]
      }

      // Если маска содержит яркость или альфу — порог бинаризации
      const intensity = (r + g + b) / 3
      const isWhite = (a > 30 && intensity >= threshold) || (a > threshold && intensity > 20)
      const val = isWhite ? 255 : 0

      rawPixelData[dstIdx] = val     // R
      rawPixelData[dstIdx + 1] = val // G
      rawPixelData[dstIdx + 2] = val // B
      rawPixelData[dstIdx + 3] = 255 // A (100% Opaque)
    }
  }

  // Опциональное масштабирование к целевым размерам targetWidth x targetHeight
  let outWidth = width
  let outHeight = height
  let outPixelData = rawPixelData

  if (targetWidth && targetHeight && (targetWidth !== width || targetHeight !== height)) {
    outWidth = targetWidth
    outHeight = targetHeight
    outPixelData = Buffer.alloc(outHeight * outWidth * 4)

    for (let y = 0; y < outHeight; y++) {
      const srcY = Math.min(height - 1, Math.floor((y * height) / outHeight))
      for (let x = 0; x < outWidth; x++) {
        const srcX = Math.min(width - 1, Math.floor((x * width) / outWidth))
        const srcIdx = (srcY * width + srcX) * 4
        const dstIdx = (y * outWidth + x) * 4
        outPixelData[dstIdx] = rawPixelData[srcIdx]
        outPixelData[dstIdx + 1] = rawPixelData[srcIdx + 1]
        outPixelData[dstIdx + 2] = rawPixelData[srcIdx + 2]
        outPixelData[dstIdx + 3] = rawPixelData[srcIdx + 3]
      }
    }
  }

  // Кодируем результат обратно в стандартный PNG (Filter 0)
  const newScanlines = Buffer.alloc(outHeight * (1 + outWidth * 4))
  for (let y = 0; y < outHeight; y++) {
    newScanlines[y * (1 + outWidth * 4)] = 0 // Filter type 0
    outPixelData.copy(newScanlines, y * (1 + outWidth * 4) + 1, y * outWidth * 4, (y + 1) * outWidth * 4)
  }

  const newIdat = zlib.deflateSync(newScanlines)

  // Формируем результирующий Buffer PNG
  function makeChunk(typeStr: string, dataBuf: Buffer): Buffer {
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(dataBuf.length, 0)
    const typeBuf = Buffer.from(typeStr, 'ascii')
    const crcBuf = Buffer.alloc(4)
    const crcVal = zlib.crc32(Buffer.concat([typeBuf, dataBuf]))
    crcBuf.writeUInt32BE(crcVal >>> 0, 0)
    return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf])
  }

  const header = Buffer.from('89504e470d0a1a0a', 'hex')

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(outWidth, 0)
  ihdrData.writeUInt32BE(outHeight, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // RGBA
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace

  const ihdrChunk = makeChunk('IHDR', ihdrData)
  const idatChunk = makeChunk('IDAT', newIdat)
  const iendChunk = makeChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([header, ihdrChunk, idatChunk, iendChunk])
}
