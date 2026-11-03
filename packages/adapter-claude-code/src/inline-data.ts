import { object, string, type SavedRecord } from './history-items.js'

// PNG states its size in its first 24 bytes and JPEG after its tables, which these
// characters (48 KiB decoded) cover for screenshots; a larger header leaves it unknown.
const IMAGE_HEAD_CHARS = 64 * 1024

type Size = { width: number; height: number }

function pngSize(bytes: Buffer): Size | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function jpegSize(bytes: Buffer): Size | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  for (let at = 2; at + 9 <= bytes.length;) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1]!
    // Fill bytes may pad a marker.
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Start-of-frame markers; C4, C8 and CC share the range but hold tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return undefined
}

function imageSize(data: string): Size | undefined {
  const bytes = Buffer.from(data.slice(0, IMAGE_HEAD_CHARS), 'base64')
  const size = pngSize(bytes) ?? jpegSize(bytes)
  return size && size.width > 0 && size.height > 0 ? size : undefined
}

/**
 * A content block with any inline file data replaced by a short text, inside tool results
 * too. A sub-agent's saved conversation is mostly screenshots (95% of 5 MB at the median,
 * up to 122 MB), and its detail asks for it every few seconds while the agent runs.
 */
export function withoutInlineData<T>(part: T): T | SavedRecord {
  const block = object(part)
  const source = object(block.source)
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = string(source.media_type)
    if (block.type !== 'image' && !mediaType?.startsWith('image/'))
      return { type: 'text', text: '[Attached file]' }
    const size = imageSize(source.data)
    return {
      type: 'text',
      text: size ? `[Screenshot ${size.width}×${size.height}]` : '[Screenshot]',
    }
  }
  return Array.isArray(block.content)
    ? { ...block, content: block.content.map(withoutInlineData) }
    : part
}
