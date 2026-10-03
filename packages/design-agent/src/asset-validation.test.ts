import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseAssetManifest,
  validateAssetManifestForPage,
  validateResolvedDesignAssets,
  type DesignAsset,
} from './assets.js'
import type { PageBlueprint } from './page.js'
import { readRasterMetadata } from './raster-metadata.js'

const roots: string[] = []
function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'taste-asset-validation-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const page = {
  sections: [{ id: 'hero', assetNeeds: ['media'], componentNeeds: [] }],
} as unknown as PageBlueprint

function asset(kind: 'font' | 'video', extension: string): DesignAsset {
  return {
    id: 'media',
    kind,
    role: kind,
    status: 'ready',
    purpose: 'Hero media',
    requirements: [],
    sectionIds: ['hero'],
    source: {
      kind: 'external',
      reference: 'https://example.com/media',
      license: 'Licensed for reuse',
    },
    destination: `media.${extension}`,
  }
}

function fontBytes(signature: string, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  bytes.write(signature, 0, 'latin1')
  if (signature === 'wOFF' || signature === 'wOF2') bytes.writeUInt32BE(size, 8)
  return bytes
}

describe('local asset content validation', () => {
  it.each([
    ['woff2', 'wOF2', 48, 'font/woff2'],
    ['woff', 'wOFF', 44, 'font/woff'],
    ['ttf', '\0\x01\0\0', 12, 'font/ttf'],
    ['otf', 'OTTO', 12, 'font/otf'],
  ])(
    'validates %s magic bytes, extension and reported content type',
    (extension, signature, size, contentType) => {
      const root = workspace()
      const font = asset('font', extension)
      font.source!.contentType = contentType
      const manifest = parseAssetManifest({ version: 1, assets: [font] })
      expect(manifest.assets[0]!.source!.contentType).toBe(contentType)
      const file = path.join(root, font.destination!)
      writeFileSync(file, '<!doctype html><html>Download unavailable</html>')
      expect(() => validateAssetManifestForPage(manifest, page, root)).toThrow('recognizable WOFF2')
      writeFileSync(file, fontBytes(signature, size))
      expect(() => validateAssetManifestForPage(manifest, page, root)).not.toThrow()
      manifest.assets[0]!.source!.contentType = 'text/html; charset=utf-8'
      expect(() => validateAssetManifestForPage(manifest, page, root)).toThrow(
        'content type text/html',
      )
      manifest.assets[0]!.source!.contentType = 'application/octet-stream'
      expect(() => validateAssetManifestForPage(manifest, page, root)).not.toThrow()
      writeFileSync(file, fontBytes(signature, size).subarray(0, 4))
      expect(() => validateAssetManifestForPage(manifest, page, root)).toThrow('recognizable WOFF2')
    },
  )

  it('rejects mismatched font extensions and truncated WOFF containers', () => {
    const root = workspace()
    const font = asset('font', 'woff2')
    const manifest = parseAssetManifest({ version: 1, assets: [font] })
    const file = path.join(root, font.destination!)
    writeFileSync(file, fontBytes('OTTO', 12))
    expect(() => validateAssetManifestForPage(manifest, page, root)).toThrow(
      'extension does not match',
    )
    const bytes = fontBytes('wOF2', 48)
    bytes.writeUInt32BE(1024, 8)
    writeFileSync(file, bytes)
    expect(() => validateAssetManifestForPage(manifest, page, root)).toThrow(
      'invalid font file length',
    )
  })

  it('requires external videos to be downloaded with reuse terms before resolving them', () => {
    const root = workspace()
    const video = asset('video', 'mp4')
    const remoteOnly = {
      ...video,
      status: 'existing',
      destination: undefined,
      source: { kind: 'external', reference: 'https://example.com/video' },
    }
    const unresolved = parseAssetManifest({ version: 1, assets: [remoteOnly] })
    expect(() => validateAssetManifestForPage(unresolved, page, root)).toThrow(
      'download external assets',
    )
    expect(() =>
      parseAssetManifest({
        version: 1,
        assets: [{ ...remoteOnly, status: 'ready', destination: 'media.mp4' }],
      }),
    ).toThrow('require a license')
    const manifest = parseAssetManifest({ version: 1, assets: [video] })
    expect(() => validateResolvedDesignAssets(unresolved)).toThrow('remain unresolved')
    expect(() => validateAssetManifestForPage(manifest, page, root)).toThrow()
    writeFileSync(path.join(root, 'media.mp4'), Buffer.from([0, 0, 0, 20, 102, 116, 121, 112]))
    expect(
      validateResolvedDesignAssets(validateAssetManifestForPage(manifest, page, root)),
    ).toEqual(manifest)
    expect(() =>
      validateResolvedDesignAssets(
        parseAssetManifest({
          version: 1,
          assets: [{ ...video, status: 'needed' }],
        }),
      ),
    ).toThrow('remain unresolved')
  })
})

function jpeg(orientation?: number, littleEndian = true, afterFrame = false): Buffer {
  const frame = Buffer.from([0xff, 0xc0, 0, 7, 8, 0x03, 0x84, 0x06, 0x40])
  const tiff = Buffer.alloc(26)
  tiff.write(littleEndian ? 'II' : 'MM')
  const uint16 = (value: number, offset: number) =>
    littleEndian ? tiff.writeUInt16LE(value, offset) : tiff.writeUInt16BE(value, offset)
  const uint32 = (value: number, offset: number) =>
    littleEndian ? tiff.writeUInt32LE(value, offset) : tiff.writeUInt32BE(value, offset)
  uint16(42, 2)
  uint32(8, 4)
  uint16(1, 8)
  uint16(0x0112, 10)
  uint16(3, 12)
  uint32(1, 14)
  uint16(orientation ?? 1, 18)
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 34]), Buffer.from('Exif\0\0'), tiff])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(orientation === undefined ? [frame] : afterFrame ? [frame, exif] : [exif, frame]),
    Buffer.from([0xff, 0xd9]),
  ])
}

describe('JPEG display orientation', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'uses display dimensions for EXIF orientation %s',
    (orientation) => {
      const root = workspace()
      const file = path.join(root, 'photo.jpg')
      for (const littleEndian of [true, false]) {
        for (const afterFrame of [true, false]) {
          writeFileSync(file, jpeg(orientation, littleEndian, afterFrame))
          expect(readRasterMetadata(file)).toMatchObject(
            orientation >= 5 ? { width: 900, height: 1600 } : { width: 1600, height: 900 },
          )
        }
      }
    },
  )

  it('accepts a portrait phone photograph at its displayed aspect ratio', () => {
    const root = workspace()
    writeFileSync(path.join(root, 'photo.jpg'), jpeg(6))
    const manifest = parseAssetManifest({
      version: 1,
      assets: [
        {
          ...asset('video', 'jpg'),
          kind: 'image',
          role: 'photography',
          destination: 'photo.jpg',
          aspectRatio: '9:16',
          composition: 'Portrait photograph',
        },
      ],
    })
    expect(() => validateAssetManifestForPage(manifest, page, root)).not.toThrow()
  })

  it('ignores absent, invalid and out-of-bounds EXIF metadata safely', () => {
    const root = workspace()
    const file = path.join(root, 'photo.jpg')
    const invalidOffset = jpeg(6)
    invalidOffset.writeUInt32LE(0xffffffff, 16)
    const truncatedDirectory = jpeg(6)
    truncatedDirectory.writeUInt32LE(24, 16)
    for (const bytes of [jpeg(), jpeg(0), jpeg(9), invalidOffset, truncatedDirectory]) {
      writeFileSync(file, bytes)
      expect(readRasterMetadata(file)).toMatchObject({ width: 1600, height: 900 })
    }
  })
})
