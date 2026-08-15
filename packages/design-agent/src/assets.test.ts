import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAssetManifest, writeAssetManifest } from './assets.js'

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

describe('asset manifest', () => {
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
})
