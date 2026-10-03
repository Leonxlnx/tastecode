import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MAX_PASTED_FILE_BYTES = 25 * 1024 * 1024

export type PastedFile = { bytes: Buffer; name: string }

export async function savePastedFile(userData: string, payload: unknown): Promise<string> {
  const file = pastedFile(payload)
  // Transcripts retain these paths indefinitely; only their owner can decide
  // when an attachment is unreferenced, so age alone must never prune it.
  const directory = path.join(userData, 'pasted-files')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = path.join(directory, `${randomUUID()}-${file.name}`)
  await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 })
  return destination
}

export function pastedFile(payload: unknown): PastedFile {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Invalid pasted file metadata')
  }
  const candidate = payload as { name?: unknown; type?: unknown; bytes?: unknown }
  if (
    typeof candidate.name !== 'string' ||
    typeof candidate.type !== 'string' ||
    !(candidate.bytes instanceof ArrayBuffer || ArrayBuffer.isView(candidate.bytes))
  ) {
    throw new Error('Invalid pasted file metadata')
  }

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
  if (
    (type === 'image/png' || type === 'image/apng') &&
    hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return '.png'
  }
  if (type === 'image/avif' && isAvif(bytes)) return '.avif'
  if (
    (type === 'image/x-icon' || type === 'image/vnd.microsoft.icon') &&
    hasPrefix(bytes, [0x00, 0x00, 0x01, 0x00])
  ) {
    return '.ico'
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

/** ISO BMFF `ftyp` box whose major or compatible brands name AVIF. */
function isAvif(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return false
  const boxEnd = Math.min(bytes.readUInt32BE(0), bytes.length, 256)
  for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
    if (offset === 12) continue // minor version
    const brand = bytes.subarray(offset, offset + 4).toString('ascii')
    if (brand === 'avif' || brand === 'avis') return true
  }
  return false
}

/**
 * Most file systems cap a name at 255 bytes; the saved name also carries a
 * 37-byte UUID prefix. Keep a safe margin below that.
 */
const MAX_NAME_BYTES = 160

function safeFileName(name: string): string {
  const leaf = path.basename(name.replaceAll('\\', '/'))
  const cleaned = leaf
    .normalize('NFC')
    // oxlint-disable-next-line no-control-regex -- File names must reject control bytes.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/^\.+/, '')
    .trim()
  // Media previews classify by extension, so truncation shortens only the stem.
  const extension = /\.[a-z0-9]{1,15}$/i.exec(cleaned)?.[0] ?? ''
  const stem = truncateUtf8(
    cleaned.slice(0, cleaned.length - extension.length),
    MAX_NAME_BYTES - extension.length,
  ).trim()
  const safe = stem ? `${stem}${extension}` : `pasted-file${extension}`
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const character of value) {
    bytes += Buffer.byteLength(character)
    if (bytes > maxBytes) break
    end += character.length
  }
  return value.slice(0, end)
}

function hasPrefix(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}
