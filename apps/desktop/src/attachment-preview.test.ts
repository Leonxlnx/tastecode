import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attachmentByteRange,
  attachmentPreviewFromUrl,
  pickedAttachment,
} from './attachment-preview.js'

const secret = Buffer.from('attachment-preview-test-secret')

describe('attachment previews', () => {
  it.each([
    ['reference.PNG', 'image', 'image/png'],
    ['walkthrough.mp4', 'video', 'video/mp4'],
  ] as const)('signs a scoped preview URL for %s', (name, mediaType, mimeType) => {
    const filePath = path.resolve('fixtures', name)
    const picked = pickedAttachment(filePath, secret)

    expect(picked).toMatchObject({ path: filePath, name, mediaType })
    expect(attachmentPreviewFromUrl(picked.previewUrl!, secret)).toEqual({
      path: filePath,
      mediaType,
      mimeType,
      variant: 'media',
    })
    expect(picked.thumbnailUrl).toBe(`${picked.previewUrl}?thumbnail=1`)
  })

  it.each(['brief.pdf', 'diagram.svg'])('leaves %s as a path-only attachment', (name) => {
    const filePath = path.resolve('fixtures', name)
    expect(pickedAttachment(filePath, secret)).toEqual({ path: filePath, name })
  })

  it('rejects a preview URL whose signed path was changed', () => {
    const first = pickedAttachment(path.resolve('fixtures', 'one.png'), secret).previewUrl!
    const second = pickedAttachment(path.resolve('fixtures', 'two.png'), secret).previewUrl!
    const tampered = `${first.slice(0, first.lastIndexOf('/') + 1)}${second.slice(second.lastIndexOf('/') + 1)}`

    expect(attachmentPreviewFromUrl(tampered, secret)).toBeUndefined()
  })

  it('scopes the video poster variant without broadening the signed path', () => {
    const picked = pickedAttachment(path.resolve('fixtures', 'walkthrough.mp4'), secret)

    expect(attachmentPreviewFromUrl(picked.thumbnailUrl!, secret)).toMatchObject({
      mediaType: 'video',
      variant: 'thumbnail',
    })
    expect(attachmentPreviewFromUrl(`${picked.previewUrl}?thumbnail=2`, secret)).toBeUndefined()
    expect(
      attachmentPreviewFromUrl(`${picked.previewUrl}?thumbnail=1&extra=1`, secret),
    ).toBeUndefined()
  })
})

describe('attachment byte ranges', () => {
  it('supports bounded, open-ended, and suffix video requests', () => {
    expect(attachmentByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(attachmentByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(attachmentByteRange('bytes=-12', 100)).toEqual({ start: 88, end: 99 })
  })

  it('rejects invalid and out-of-bounds ranges', () => {
    expect(attachmentByteRange('bytes=100-', 100)).toBe('invalid')
    expect(attachmentByteRange('bytes=20-10', 100)).toBe('invalid')
    expect(attachmentByteRange('bytes=0-1,4-5', 100)).toBe('invalid')
  })
})
