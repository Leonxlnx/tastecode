import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const MAX_ATTACHMENT_BYTES = 25 * 1_024 * 1_024

const MAX_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
const DEFAULT_DIRECTORY = path.join(os.tmpdir(), 'Personal Harness', 'attachments')

export async function materializeAttachment(
  input: { name: string; data: string },
  directory = DEFAULT_DIRECTORY,
): Promise<string> {
  if (input.data.length > MAX_BASE64_LENGTH) {
    throw new Error('attachment exceeds the 25 MB limit')
  }
  if (!isValidBase64(input.data)) {
    throw new Error('attachment data is not valid base64')
  }

  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error('attachment exceeds the 25 MB limit')
  }

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = path.join(directory, `${randomUUID()}-${safeFileName(input.name)}`)
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
  return target
}

function isValidBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  let contentLength = value.length
  while (contentLength > 0 && value.charCodeAt(contentLength - 1) === 61) contentLength -= 1
  if (value.length - contentLength > 2) return false

  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index)
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    if (!valid) return false
  }
  return true
}

export function imageFileName(mimeType: string): string {
  switch (mimeType.toLowerCase().split(';', 1)[0]?.trim()) {
    case 'image/jpeg':
      return 'image.jpg'
    case 'image/gif':
      return 'image.gif'
    case 'image/webp':
      return 'image.webp'
    case 'image/bmp':
      return 'image.bmp'
    case 'image/heic':
      return 'image.heic'
    case 'image/heif':
      return 'image.heif'
    default:
      return 'image.png'
  }
}

function safeFileName(name: string): string {
  const leaf = name.replaceAll('\\', '/').split('/').pop() ?? ''
  const cleaned = leaf
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.slice(0, 160) || 'attachment'
}
