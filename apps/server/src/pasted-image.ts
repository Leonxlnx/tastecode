import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

export async function savePastedImage(
  image: { mimeType: string; data: string },
  directory = path.join(os.tmpdir(), 'Personal Harness', 'pasted-images'),
): Promise<string> {
  const bytes = decodeImage(image.data)
  const extension = imageExtension(image.mimeType, bytes)
  if (!extension) throw new Error('Unsupported pasted image')

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = path.join(directory, `pasted-${randomUUID()}${extension}`)
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  return destination
}

function decodeImage(data: string): Buffer {
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new Error('Invalid pasted image data')
  }

  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_PASTED_IMAGE_BYTES) {
    throw new Error('Pasted image is empty or too large')
  }
  return bytes
}

function imageExtension(type: string, bytes: Buffer): string | undefined {
  if (type === 'image/png' && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return '.png'
  }
  if (type === 'image/jpeg' && hasPrefix(bytes, [0xff, 0xd8, 0xff])) return '.jpg'
  if (type === 'image/gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
    return '.gif'
  }
  if (
    type === 'image/webp' &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp'
  }
  if (type === 'image/bmp' && bytes.subarray(0, 2).toString('ascii') === 'BM') return '.bmp'
  return undefined
}

function hasPrefix(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}
