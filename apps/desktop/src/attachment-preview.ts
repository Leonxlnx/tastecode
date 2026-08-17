import { createHmac, timingSafeEqual } from 'node:crypto'
import path from 'node:path'

export const ATTACHMENT_PREVIEW_SCHEME = 'tastecode-attachment'

export type AttachmentMediaType = 'image' | 'video'

export type PickedAttachment = {
  path: string
  name: string
  mediaType?: AttachmentMediaType
  previewUrl?: string
  thumbnailUrl?: string
}

type PreviewMediaDescriptor = {
  path: string
  mediaType: AttachmentMediaType
  mimeType: string
}

type PreviewMedia = PreviewMediaDescriptor & {
  variant: 'media' | 'thumbnail'
}

const MEDIA_BY_EXTENSION = new Map<string, Omit<PreviewMediaDescriptor, 'path'>>([
  ['.apng', { mediaType: 'image', mimeType: 'image/apng' }],
  ['.avif', { mediaType: 'image', mimeType: 'image/avif' }],
  ['.bmp', { mediaType: 'image', mimeType: 'image/bmp' }],
  ['.gif', { mediaType: 'image', mimeType: 'image/gif' }],
  ['.ico', { mediaType: 'image', mimeType: 'image/x-icon' }],
  ['.jpeg', { mediaType: 'image', mimeType: 'image/jpeg' }],
  ['.jpg', { mediaType: 'image', mimeType: 'image/jpeg' }],
  ['.png', { mediaType: 'image', mimeType: 'image/png' }],
  ['.webp', { mediaType: 'image', mimeType: 'image/webp' }],
  ['.avi', { mediaType: 'video', mimeType: 'video/x-msvideo' }],
  ['.m4v', { mediaType: 'video', mimeType: 'video/mp4' }],
  ['.mkv', { mediaType: 'video', mimeType: 'video/x-matroska' }],
  ['.mov', { mediaType: 'video', mimeType: 'video/quicktime' }],
  ['.mp4', { mediaType: 'video', mimeType: 'video/mp4' }],
  ['.mpeg', { mediaType: 'video', mimeType: 'video/mpeg' }],
  ['.mpg', { mediaType: 'video', mimeType: 'video/mpeg' }],
  ['.ogg', { mediaType: 'video', mimeType: 'video/ogg' }],
  ['.ogv', { mediaType: 'video', mimeType: 'video/ogg' }],
  ['.webm', { mediaType: 'video', mimeType: 'video/webm' }],
])

export function pickedAttachment(filePath: string, secret: Buffer): PickedAttachment {
  const media = previewMedia(filePath)
  const base = {
    path: filePath,
    name: path.basename(filePath),
  }
  if (!media) return base
  const previewUrl = signedAttachmentPreviewUrl(filePath, secret)
  return {
    ...base,
    mediaType: media.mediaType,
    previewUrl,
    thumbnailUrl: `${previewUrl}?thumbnail=1`,
  }
}

export function attachmentPreviewFromUrl(value: string, secret: Buffer): PreviewMedia | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (
    url.protocol !== `${ATTACHMENT_PREVIEW_SCHEME}:` ||
    url.hostname !== 'preview' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.search !== '' && url.search !== '?thumbnail=1') ||
    url.hash !== ''
  ) {
    return undefined
  }

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2) return undefined
  const [signature, encodedPath] = parts
  if (!signature || !encodedPath) return undefined

  const actual = Buffer.from(signature, 'base64url')
  const expected = sign(encodedPath, secret)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined

  const filePath = Buffer.from(encodedPath, 'base64url').toString('utf8')
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) return undefined
  const media = previewMedia(filePath)
  return media
    ? { ...media, variant: url.search === '?thumbnail=1' ? 'thumbnail' : 'media' }
    : undefined
}

export type AttachmentByteRange = { start: number; end: number } | 'invalid' | undefined

export function attachmentByteRange(value: string | null, size: number): AttachmentByteRange {
  if (value === null) return undefined
  if (!Number.isSafeInteger(size) || size < 0) return 'invalid'
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size === 0) return 'invalid'

  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText === '' && endText === '') return 'invalid'

  if (startText === '') {
    const suffixLength = Number(endText)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(startText)
  const requestedEnd = endText === '' ? size - 1 : Number(endText)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return 'invalid'
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function signedAttachmentPreviewUrl(filePath: string, secret: Buffer): string {
  const encodedPath = Buffer.from(filePath, 'utf8').toString('base64url')
  const signature = sign(encodedPath, secret).toString('base64url')
  return `${ATTACHMENT_PREVIEW_SCHEME}://preview/${signature}/${encodedPath}`
}

function sign(encodedPath: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(encodedPath).digest()
}

function previewMedia(filePath: string): PreviewMediaDescriptor | undefined {
  const media = MEDIA_BY_EXTENSION.get(path.extname(filePath).toLowerCase())
  return media ? { path: filePath, ...media } : undefined
}
