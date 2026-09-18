import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { snapshotDesignAssets } from './file-snapshot.js'
import {
  parseAssetManifest,
  validateAssetManifestForPage,
  validateResolvedDesignAssets,
  writeAssetManifest,
} from './assets.js'

const manifest = {
  version: 1,
  assets: [
    {
      id: 'hero-product',
      kind: 'image',
      status: 'needed',
      purpose: 'Lead the hero with the featured coffee bag.',
      requirements: ['Transparent background', 'Warm directional light'],
    },
    {
      id: 'product-card',
      kind: 'component',
      status: 'ready',
      purpose: 'Present the roast and purchase action.',
      requirements: ['Keyboard accessible'],
      source: { kind: 'origin-kit', reference: 'product-card' },
      destination: 'src/components/ProductCard.tsx',
    },
  ],
}

function png(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8)
  return chunk
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('asset manifest', () => {
  it('accepts generated PNG provenance metadata containing an SVG icon unchanged', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-png-provenance-'))
    const page = {
      sections: [{ id: 'hero', assetNeeds: ['photo'], componentNeeds: [] }],
    } as unknown as Parameters<typeof validateAssetManifestForPage>[1]
    const image = png(1600, 900)
    const original = Buffer.concat([
      image.subarray(0, 33),
      pngChunk('caBX', Buffer.from('Provenance icon: <svg viewBox="0 0 10 10"></svg>')),
      image.subarray(33),
    ])
    const assets = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'photo',
          kind: 'image',
          role: 'photography',
          status: 'ready',
          purpose: 'Hero photograph',
          requirements: [],
          sectionIds: ['hero'],
          aspectRatio: '16:9',
          composition: 'Wide café interior',
          source: { kind: 'generated', reference: 'image generation' },
          destination: 'photo.png',
        },
      ],
    })
    try {
      writeFileSync(path.join(workspace, 'photo.png'), original)
      expect(validateAssetManifestForPage(assets, page, workspace)).toEqual(assets)
      expect(readFileSync(path.join(workspace, 'photo.png'))).toEqual(original)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('expands a font family directory into concrete snapshotted files', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-font-family-'))
    const page = {
      sections: [{ id: 'hero', assetNeeds: ['font_bodoni'], componentNeeds: [] }],
    } as unknown as Parameters<typeof validateAssetManifestForPage>[1]
    const assets = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'font_bodoni',
          kind: 'font',
          role: 'font',
          status: 'ready',
          purpose: 'Headings and real italic',
          requirements: [],
          sectionIds: ['hero'],
          source: { kind: 'project', reference: 'fonts/bodoni' },
          destination: 'fonts/bodoni',
        },
      ],
    })
    try {
      mkdirSync(path.join(workspace, 'fonts/bodoni'), { recursive: true })
      writeFileSync(path.join(workspace, 'fonts/bodoni/regular.ttf'), 'regular font')
      writeFileSync(path.join(workspace, 'fonts/bodoni/italic.ttf'), 'italic font')
      writeFileSync(path.join(workspace, 'fonts/bodoni/OFL.txt'), 'font license')
      const resolved = validateAssetManifestForPage(assets, page, workspace)
      expect(resolved.assets).toHaveLength(2)
      expect(resolved.assets[0]?.id).toBe('font_bodoni')
      expect(resolved.assets.map(({ destination }) => destination).sort()).toEqual([
        'fonts/bodoni/italic.ttf',
        'fonts/bodoni/regular.ttf',
      ])
      expect(snapshotDesignAssets(workspace, resolved)).toHaveLength(2)
      expect(validateAssetManifestForPage(resolved, page, workspace)).toEqual(resolved)
      mkdirSync(path.join(workspace, 'empty'))
      expect(() =>
        validateAssetManifestForPage(
          {
            ...assets,
            assets: [{ ...assets.assets[0]!, destination: 'empty' }],
          },
          page,
          workspace,
        ),
      ).toThrow('directory contains no font files')
      expect(() =>
        validateAssetManifestForPage(
          {
            ...assets,
            assets: [{ ...assets.assets[0]!, destination: '../' }],
          },
          page,
          workspace,
        ),
      ).toThrow('must stay inside the workspace')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('keeps a credited photograph assigned to its consuming section', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-credited-photo-'))
    const page = {
      sections: [
        { id: 'hero', assetNeeds: ['office-photo'], componentNeeds: [] },
        { id: 'footer', assetNeeds: [], componentNeeds: [] },
      ],
    } as unknown as Parameters<typeof validateAssetManifestForPage>[1]
    const photo = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'office-photo',
          kind: 'image',
          role: 'photography',
          status: 'ready',
          purpose: 'Hero photograph with a footer credit',
          requirements: ['Credit the photographer in the footer'],
          sectionIds: ['hero'],
          aspectRatio: '16:9',
          composition: 'Wide office photograph',
          source: {
            kind: 'external',
            reference: 'https://example.com/photo',
            license: 'Photographer; licensed for reuse',
          },
          destination: 'office.png',
        },
      ],
    })
    try {
      writeFileSync(path.join(workspace, 'office.png'), png(1600, 900))
      expect(validateAssetManifestForPage(photo, page, workspace)).toEqual(photo)
      expect(() =>
        validateAssetManifestForPage(
          {
            ...photo,
            assets: [{ ...photo.assets[0]!, sectionIds: ['hero', 'footer'] }],
          },
          page,
          workspace,
        ),
      ).toThrow('sectionIds must exactly match hero')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('validates real attribution JSON as data without treating it as a component', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-data-asset-'))
    const page = {
      sections: [{ id: 'footer', assetNeeds: ['credits'], componentNeeds: [] }],
    } as unknown as Parameters<typeof validateAssetManifestForPage>[1]
    const credits = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'credits',
          kind: 'data',
          role: 'data',
          status: 'ready',
          purpose: 'Photo credits',
          requirements: [],
          sectionIds: ['footer'],
          source: { kind: 'project', reference: 'credits.json' },
          destination: 'credits.json',
        },
      ],
    })
    try {
      writeFileSync(
        path.join(workspace, 'credits.json'),
        JSON.stringify({ creator: 'Photographer', source: 'https://example.com/photo' }),
      )
      expect(validateAssetManifestForPage(credits, page, workspace)).toEqual(credits)
      writeFileSync(path.join(workspace, 'credits.json'), '<html>not data</html>')
      expect(() => validateAssetManifestForPage(credits, page, workspace)).toThrow(
        'valid JSON within 1 MB',
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
  it('accepts shared brand fonts while rejecting unknown consuming sections and extra visuals', () => {
    const page = {
      sections: [{ id: 'hero', assetNeeds: [], componentNeeds: [] }],
    } as unknown as Parameters<typeof validateAssetManifestForPage>[1]
    const fonts = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'brand-font',
          kind: 'font',
          role: 'font',
          status: 'needed',
          purpose: 'Approved heading typography',
          requirements: [],
          sectionIds: ['hero'],
        },
      ],
    })
    expect(validateAssetManifestForPage(fonts, page)).toEqual(fonts)
    expect(() =>
      validateAssetManifestForPage(
        { version: 1, assets: [{ ...fonts.assets[0]!, sectionIds: ['missing'] }] },
        page,
      ),
    ).toThrow('existing consuming')
    expect(() =>
      validateAssetManifestForPage(
        { version: 1, assets: [{ ...fonts.assets[0]!, kind: 'image', role: 'photography' }] },
        page,
      ),
    ).toThrow('extra: brand-font')
  })

  it('rejects malformed ratios and credential-bearing external source URLs', () => {
    const asset = { ...manifest.assets[0], aspectRatio: `${'9'.repeat(400)}:1` }
    expect(() => parseAssetManifest({ version: 1, assets: [asset] })).toThrow(
      'positive width:height',
    )
    expect(() =>
      parseAssetManifest({
        version: 1,
        assets: [
          {
            ...manifest.assets[0],
            source: { kind: 'external', reference: 'https://name:password@example.com/photo' },
          },
        ],
      }),
    ).toThrow('without credentials')
    expect(() =>
      parseAssetManifest({
        version: 1,
        assets: [
          { ...manifest.assets[0], source: { kind: 'external', reference: 'file:///tmp/photo' } },
        ],
      }),
    ).toThrow('HTTP source page URL')
  })

  it('rejects fake PNG data even when its header advertises production dimensions', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-asset-png-data-'))
    const page = {
      sections: [{ id: 'hero', assetNeeds: ['photo'], componentNeeds: [] }],
    } as unknown as Parameters<typeof validateAssetManifestForPage>[1]
    const asset = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'photo',
          kind: 'image',
          status: 'ready',
          purpose: 'Hero',
          requirements: [],
          role: 'photography',
          sectionIds: ['hero'],
          aspectRatio: '16:9',
          composition: 'Wide scene',
          source: { kind: 'generated', reference: 'local generation' },
          destination: 'photo.png',
        },
      ],
    })
    try {
      const valid = png(1600, 900)
      const wrongChecksum = Buffer.from(valid)
      wrongChecksum[32] = wrongChecksum[32]! ^ 0xff
      writeFileSync(path.join(workspace, 'photo.png'), wrongChecksum)
      expect(() => validateAssetManifestForPage(asset, page, workspace)).toThrow(
        'invalid PNG image data',
      )
      writeFileSync(
        path.join(workspace, 'photo.png'),
        Buffer.concat([
          valid.subarray(0, 33),
          pngChunk('IDAT', deflateSync(Buffer.from('tiny'))),
          pngChunk('IEND', Buffer.alloc(0)),
        ]),
      )
      expect(() => validateAssetManifestForPage(asset, page, workspace)).toThrow(
        'invalid PNG image data',
      )
      writeFileSync(path.join(workspace, 'photo.png'), valid)
      expect(() => validateAssetManifestForPage(asset, page, workspace)).not.toThrow()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('writes unresolved and ready assets', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-assets-'))
    const parsed = writeAssetManifest(workspace, manifest)

    expect(parsed.assets).toHaveLength(2)
    expect(JSON.parse(readFileSync(path.join(workspace, '.taste', 'assets.json'), 'utf8'))).toEqual(
      parsed,
    )
  })

  it('allows a page with no external asset needs', () => {
    expect(parseAssetManifest({ version: 1, assets: [] })).toEqual({ version: 1, assets: [] })
  })

  it('does not let Build complete with meaningful imagery still unresolved', () => {
    const unresolved = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'hero-photo',
          kind: 'image',
          status: 'needed',
          purpose: 'Reference-matched hero photograph.',
          requirements: [],
          role: 'photography',
          sectionIds: ['hero'],
          aspectRatio: '16:9',
          composition: 'Wide environmental scene.',
        },
      ],
    })
    expect(() => validateResolvedDesignAssets(unresolved)).toThrow(
      'Build must fail instead of substituting SVG or generic filler: hero-photo',
    )
  })

  it('rejects a ready asset without provenance and a destination', () => {
    expect(() =>
      parseAssetManifest({
        version: 1,
        assets: [{ ...manifest.assets[0], status: 'ready' }],
      }),
    ).toThrow('ready assets require source and destination')
  })

  it('rejects a ready external asset without recorded reuse terms', () => {
    expect(() =>
      parseAssetManifest({
        version: 1,
        assets: [
          {
            ...manifest.assets[0],
            status: 'ready',
            source: { kind: 'external', reference: 'https://example.com/photo' },
            destination: 'public/photo.jpg',
          },
        ],
      }),
    ).toThrow('ready external assets require a license')
  })

  it('requires exact section coverage and concrete composition for page visuals', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-asset-page-'))
    const page = {
      version: 1 as const,
      sections: [{ id: 'hero', assetNeeds: ['hero-product'], componentNeeds: ['product-card'] }],
    } as unknown as Parameters<typeof validateAssetManifestForPage>[1]
    try {
      writeFileSync(path.join(workspace, 'hero.png'), png(1600, 900))
      const strictManifest = parseAssetManifest({
        version: 1,
        assets: [
          {
            id: 'hero-product',
            kind: 'image',
            status: 'ready',
            purpose: 'Reference-matched hero product photograph.',
            requirements: ['Warm directional light'],
            role: 'product_image',
            sectionIds: ['hero'],
            aspectRatio: '16:9',
            composition: 'Bag on the right with a clear left text-safe area.',
            source: { kind: 'generated', reference: 'image generation result' },
            destination: 'hero.png',
          },
          {
            id: 'product-card',
            kind: 'component',
            status: 'needed',
            purpose: 'Native product purchase card.',
            requirements: ['Keyboard accessible'],
            role: 'component',
            sectionIds: ['hero'],
          },
        ],
      })

      expect(validateAssetManifestForPage(strictManifest, page, workspace)).toEqual(strictManifest)
      expect(() =>
        validateAssetManifestForPage(
          { ...strictManifest, assets: strictManifest.assets.slice(0, 1) },
          page,
          workspace,
        ),
      ).toThrow('missing: product-card')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('sniffs SVG content disguised as a raster destination', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-asset-svg-'))
    const page = {
      version: 1 as const,
      sections: [{ id: 'hero', assetNeeds: ['hero-photo'], componentNeeds: [] }],
    } as Parameters<typeof validateAssetManifestForPage>[1]
    try {
      writeFileSync(path.join(workspace, 'hero.webp'), '<svg viewBox="0 0 10 10"></svg>')
      const disguised = parseAssetManifest({
        version: 1,
        assets: [
          {
            id: 'hero-photo',
            kind: 'image',
            status: 'ready',
            purpose: 'Hero photograph.',
            requirements: [],
            role: 'photography',
            sectionIds: ['hero'],
            aspectRatio: '16:9',
            composition: 'Wide environmental scene.',
            source: { kind: 'generated', reference: 'generation' },
            destination: 'hero.webp',
          },
        ],
      })

      expect(() => validateAssetManifestForPage(disguised, page, workspace)).toThrow(
        'is SVG content but role photography requires a real raster or video asset',
      )

      const iconPage = {
        version: 1 as const,
        sections: [{ id: 'hero', assetNeeds: ['hero-icon'], componentNeeds: [] }],
      } as unknown as Parameters<typeof validateAssetManifestForPage>[1]
      const generatedIcon = parseAssetManifest({
        version: 1,
        assets: [
          {
            id: 'hero-icon',
            kind: 'icon',
            status: 'ready',
            purpose: 'Hero action icon.',
            requirements: [],
            role: 'functional_icon',
            sectionIds: ['hero'],
            source: { kind: 'generated', reference: 'generation' },
            destination: 'fake.webp',
          },
        ],
      })
      expect(() => validateAssetManifestForPage(generatedIcon, iconPage, workspace)).toThrow(
        'functional asset hero-icon cannot use a generated source',
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('requires recognizable, sufficiently large raster bytes at the declared ratio', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-asset-raster-'))
    const page = {
      version: 1 as const,
      sections: [{ id: 'hero', assetNeeds: ['hero-photo'], componentNeeds: [] }],
    } as Parameters<typeof validateAssetManifestForPage>[1]
    const asset = {
      id: 'hero-photo',
      kind: 'image' as const,
      status: 'ready' as const,
      purpose: 'Hero photograph.',
      requirements: [],
      role: 'photography' as const,
      sectionIds: ['hero'],
      aspectRatio: '16:9',
      composition: 'Wide environmental scene.',
      source: { kind: 'generated' as const, reference: 'generation' },
      destination: 'hero.png',
    }
    try {
      writeFileSync(path.join(workspace, 'hero.png'), 'not an image')
      expect(() =>
        validateAssetManifestForPage({ version: 1, assets: [asset] }, page, workspace),
      ).toThrow('must be a recognizable PNG, JPEG, WebP, or GIF')

      writeFileSync(path.join(workspace, 'hero.png'), png(64, 64))
      expect(() =>
        validateAssetManifestForPage(
          { version: 1, assets: [{ ...asset, aspectRatio: '1:1' }] },
          page,
          workspace,
        ),
      ).toThrow('too small for production use')

      writeFileSync(path.join(workspace, 'hero.png'), png(1600, 900))
      expect(() =>
        validateAssetManifestForPage(
          { version: 1, assets: [{ ...asset, aspectRatio: '1:1' }] },
          page,
          workspace,
        ),
      ).toThrow('not declared 1:1')
      expect(
        validateAssetManifestForPage({ version: 1, assets: [asset] }, page, workspace),
      ).toEqual({ version: 1, assets: [asset] })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('allows only attached user IDs and rejects workspace symlink escapes', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'harness-asset-boundary-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'harness-asset-outside-'))
    const page = {
      version: 1 as const,
      sections: [{ id: 'hero', assetNeeds: ['hero-photo'], componentNeeds: [] }],
    } as Parameters<typeof validateAssetManifestForPage>[1]
    const referencePath = path.join(outside, 'reference.png')
    const baseAsset = {
      id: 'hero-photo',
      kind: 'image' as const,
      status: 'existing' as const,
      purpose: 'Supplied hero photograph.',
      requirements: [],
      role: 'photography' as const,
      sectionIds: ['hero'],
      aspectRatio: '16:9',
      composition: 'Wide environmental scene.',
      source: { kind: 'user' as const, reference: referencePath },
    }
    try {
      writeFileSync(referencePath, png(1600, 900))
      expect(() =>
        validateAssetManifestForPage({ version: 1, assets: [baseAsset] }, page, workspace, [
          referencePath,
        ]),
      ).toThrow('must use an attached user-reference-# ID')

      const attached = {
        ...baseAsset,
        source: { kind: 'user' as const, reference: 'user-reference-1' },
        destination: 'supplied.png',
      }
      writeFileSync(path.join(workspace, 'supplied.png'), readFileSync(referencePath))
      expect(
        validateAssetManifestForPage({ version: 1, assets: [attached] }, page, workspace, [
          referencePath,
        ]),
      ).toEqual({ version: 1, assets: [attached] })
      writeFileSync(path.join(workspace, 'supplied.png'), png(1280, 720))
      expect(() =>
        validateAssetManifestForPage({ version: 1, assets: [attached] }, page, workspace, [
          referencePath,
        ]),
      ).toThrow('must contain the supplied file unchanged')

      symlinkSync(referencePath, path.join(workspace, 'escaped.png'))
      expect(() =>
        validateAssetManifestForPage(
          {
            version: 1,
            assets: [
              {
                ...baseAsset,
                source: { kind: 'project', reference: 'escaped.png' },
              },
            ],
          },
          page,
          workspace,
        ),
      ).toThrow('must stay inside the workspace after resolving symlinks')

      const outsideDestination = path.join(outside, 'ready.png')
      writeFileSync(outsideDestination, png(1600, 900))
      mkdirSync(path.join(workspace, 'public'))
      symlinkSync(outsideDestination, path.join(workspace, 'public', 'ready.png'))
      expect(() =>
        validateAssetManifestForPage(
          {
            version: 1,
            assets: [
              {
                ...baseAsset,
                status: 'ready',
                source: { kind: 'generated', reference: 'generation' },
                destination: 'public/ready.png',
              },
            ],
          },
          page,
          workspace,
        ),
      ).toThrow('must stay inside the workspace after resolving symlinks')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
