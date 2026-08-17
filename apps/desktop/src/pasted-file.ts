import path from 'node:path'
import { z } from 'zod'
import type { BoundaryValue } from './boundary.js'

export const MAX_PASTED_FILE_BYTES = 25 * 1024 * 1024

const ArrayBufferViewSchema = z.custom<ArrayBufferView>((value) => ArrayBuffer.isView(value))
const PastedFilePayloadSchema = z.object({
  name: z.string(),
  type: z.string(),
  bytes: z.union([z.instanceof(ArrayBuffer), ArrayBufferViewSchema]),
})

export type PastedFile = { bytes: Buffer; name: string }

export function pastedFile(payload: BoundaryValue): PastedFile {
  const parsed = PastedFilePayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error('Invalid pasted file metadata')
  }
  const candidate = parsed.data

  const bytes =
    candidate.bytes instanceof ArrayBuffer
      ? Buffer.from(candidate.bytes)
      : ArrayBuffer.isView(candidate.bytes)
        ? Buffer.from(
            candidate.bytes.buffer,
            candidate.bytes.byteOffset,
            candidate.bytes.byteLength,
          )
        : undefined

  if (!bytes || bytes.length === 0 || bytes.length > MAX_PASTED_FILE_BYTES) {
    throw new Error('Pasted file is empty or larger than 25 MB')
  }

  const imageExtension = candidate.type.startsWith('image/')
    ? validatedImageExtension(candidate.type, bytes)
    : undefined
  if (candidate.type.startsWith('image/') && !imageExtension) {
    throw new Error('Unsupported pasted image')
  }

  return {
    bytes,
    name: imageExtension ? `pasted-image${imageExtension}` : safeFileName(candidate.name),
  }
}

function validatedImageExtension(type: string, bytes: Buffer): string | undefined {
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

function safeFileName(name: string): string {
  const leaf = path.basename(name.replaceAll('\\', '/'))
  const cleaned = leaf
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160)
  const safe = cleaned || 'pasted-file'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe
}

function hasPrefix(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}
