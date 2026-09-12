import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { readWorkspaceFile } from './workspace-files.js'

interface RasterMetadata {
  format: 'png' | 'jpeg' | 'webp' | 'gif'
  width: number
  height: number
}

export function readRasterMetadata(filePath: string): RasterMetadata {
  const buffer = readWorkspaceFile(filePath, 32_000_000)
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buffer.subarray(0, 8).equals(pngSignature)) {
    if (
      buffer.length < 45 ||
      buffer.readUInt32BE(8) !== 13 ||
      buffer.subarray(12, 16).toString('ascii') !== 'IHDR' ||
      buffer.indexOf(Buffer.from('IDAT'), 24) < 0 ||
      buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii') !== 'IEND'
    ) {
      throw new Error(`visual file ${path.basename(filePath)} is not a complete PNG`)
    }
    const metadata = validRasterMetadata(
      'png',
      buffer.readUInt32BE(16),
      buffer.readUInt32BE(20),
      filePath,
    )
    validatePng(buffer, metadata, filePath)
    return metadata
  }

  const gifHeader = buffer.subarray(0, 6).toString('ascii')
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    if (buffer.length < 14 || buffer.at(-1) !== 0x3b) {
      throw new Error(`visual file ${path.basename(filePath)} is not a complete GIF`)
    }
    return validRasterMetadata('gif', buffer.readUInt16LE(6), buffer.readUInt16LE(8), filePath)
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const dimensions = jpegDimensions(buffer)
    if (!dimensions || buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) < 2) {
      throw new Error(`visual file ${path.basename(filePath)} is not a complete JPEG`)
    }
    return validRasterMetadata('jpeg', dimensions.width, dimensions.height, filePath)
  }

  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    if (buffer.length < 30 || buffer.readUInt32LE(4) + 8 !== buffer.length) {
      throw new Error(`visual file ${path.basename(filePath)} is not a complete WebP`)
    }
    const dimensions = webpDimensions(buffer)
    if (!dimensions) throw new Error(`visual file ${path.basename(filePath)} has invalid WebP data`)
    let imagePayload = false
    let offset = 12
    while (offset + 8 <= buffer.length) {
      const chunk = buffer.toString('ascii', offset, offset + 4)
      const length = buffer.readUInt32LE(offset + 4)
      if (offset + 8 + length > buffer.length)
        throw new Error(`visual file ${path.basename(filePath)} has a truncated WebP chunk`)
      if (
        (chunk === 'VP8 ' && length > 10) ||
        (chunk === 'VP8L' && length > 5) ||
        (chunk === 'ANMF' && length > 24)
      )
        imagePayload = true
      offset += 8 + length + (length % 2)
    }
    if (offset !== buffer.length || !imagePayload)
      throw new Error(`visual file ${path.basename(filePath)} has no WebP image payload`)
    return validRasterMetadata('webp', dimensions.width, dimensions.height, filePath)
  }

  throw new Error(
    `visual file ${path.basename(filePath)} must be a recognizable PNG, JPEG, WebP, or GIF`,
  )
}

function validRasterMetadata(
  format: RasterMetadata['format'],
  width: number,
  height: number,
  filePath: string,
): RasterMetadata {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`visual file ${path.basename(filePath)} has invalid dimensions`)
  }
  if (width * height > 16_777_216)
    throw new Error(`visual file ${path.basename(filePath)} exceeds 16 megapixels`)
  return { format, width, height }
}

function validatePng(buffer: Buffer, metadata: RasterMetadata, filePath: string): void {
  const invalid = () =>
    new Error(`visual file ${path.basename(filePath)} has invalid PNG image data`)
  const parts: Buffer[] = []
  let offset = 8
  let ended = false
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    if (offset + length + 12 > buffer.length) throw invalid()
    const chunk = buffer.toString('ascii', offset + 4, offset + 8)
    let crc = 0xffffffff
    for (const byte of buffer.subarray(offset + 4, offset + 8 + length)) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
    }
    if ((crc ^ 0xffffffff) >>> 0 !== buffer.readUInt32BE(offset + 8 + length)) throw invalid()
    if (chunk === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
    if (chunk === 'IEND') {
      ended = length === 0
      break
    }
  }
  if (!ended || offset !== buffer.length || !parts.length) throw invalid()
  const depth = buffer[24]!
  const colorType = buffer[25]!
  const channels = [1, 0, 3, 1, 2, 0, 4]
  if (
    !channels[colorType] ||
    ![1, 2, 4, 8, 16].includes(depth) ||
    ((colorType === 2 || colorType === 4 || colorType === 6) && depth < 8) ||
    (colorType === 3 && depth === 16) ||
    buffer[26] !== 0 ||
    buffer[27] !== 0 ||
    buffer[28]! > 1
  )
    throw invalid()
  const passes =
    buffer[28] === 1
      ? [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ]
      : [[0, 0, 1, 1]]
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((metadata.width - x!) / dx!))
    const height = Math.max(0, Math.ceil((metadata.height - y!) / dy!))
    return {
      height: width ? height : 0,
      stride: 1 + Math.ceil((width * channels[colorType]! * depth) / 8),
    }
  })
  const expected = rows.reduce((total, row) => total + row.height * row.stride, 0)
  if (expected > 80_000_000)
    throw new Error(`visual file ${path.basename(filePath)} PNG decoding exceeds 80 MB`)
  let decoded: Buffer
  try {
    decoded = inflateSync(Buffer.concat(parts), { maxOutputLength: expected + 1 })
  } catch {
    throw invalid()
  }
  if (decoded.length !== expected) throw invalid()
  let rowOffset = 0
  for (const { height, stride } of rows) {
    for (let row = 0; row < height; row += 1) {
      if (decoded[rowOffset]! > 4) throw invalid()
      rowOffset += stride
    }
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function jpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ])
  let offset = 2
  while (offset + 3 < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1
    const marker = buffer[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buffer.length) break
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) break
    if (startOfFrame.has(marker) && length >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return undefined
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  const kind = buffer.subarray(12, 16).toString('ascii')
  if (kind === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    }
  }
  if (
    kind === 'VP8 ' &&
    buffer.length >= 30 &&
    buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
  ) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  if (kind === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  return undefined
}
