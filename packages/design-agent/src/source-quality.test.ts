import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { designSourceQualityBaseline, validateDesignSourceQuality } from './source-quality.js'
import { parseAssetManifest, validateAssetManifestForPage } from './assets.js'

const roots: string[] = []

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-design-source-size-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('design source scan size limits', () => {
  it('accepts an unchanged uploaded SVG logo after the Assets phase', () => {
    const root = workspace()
    const upload = path.join(workspace(), 'logo.svg')
    const bytes = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>'
    writeFileSync(upload, bytes)
    writeFileSync(path.join(root, 'logo.svg'), bytes)
    const manifest = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'logo',
          kind: 'icon',
          role: 'logo',
          status: 'existing',
          purpose: 'Uploaded brand logo',
          requirements: [],
          sectionIds: ['hero'],
          source: { kind: 'user', reference: 'user-reference-1' },
          destination: 'logo.svg',
        },
      ],
    })
    const page = {
      sections: [{ id: 'hero', assetNeeds: ['logo'], componentNeeds: [] }],
    } as Parameters<typeof validateAssetManifestForPage>[1]
    const accepted = validateAssetManifestForPage(manifest, page, root, [upload])
    expect(() => validateDesignSourceQuality(root, ['logo.svg'], [], accepted)).not.toThrow()
  })

  it('scans long brace-free input and unmatched tails within a bounded time', () => {
    const root = workspace()
    const file = path.join(root, 'styles.sass')
    for (const source of [
      'x'.repeat(65_536),
      `.card { color: red; }${'x'.repeat(65_536)}`,
      `${'x'.repeat(65_536)}{${'x'.repeat(65_536)}`,
    ]) {
      writeFileSync(file, source)
      const start = performance.now()
      expect(designSourceQualityBaseline(root)).toEqual([])
      expect(performance.now() - start).toBeLessThan(500)
    }
  })

  it('checks inner CSS blocks and scans nested SVG fragments without overlapping hashes', () => {
    const root = workspace()
    writeFileSync(
      path.join(root, 'styles.css'),
      '@media (width > 600px) { .card { border-left: 2px solid; } }',
    )
    expect(() => validateDesignSourceQuality(root)).toThrow('one-sided card-edge border')
    writeFileSync(path.join(root, 'styles.css'), '')
    writeFileSync(path.join(root, 'index.html'), '<svg>'.repeat(20_000) + '</svg>'.repeat(20_000))
    const start = performance.now()
    expect(designSourceQualityBaseline(root)).toHaveLength(1)
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('accepts large HTML with embedded images during baseline and validation', () => {
    const root = workspace()
    const file = 'comparison-mobile.html'
    const source = `<img src="data:image/png;base64,${'A'.repeat(2_100_000)}">`
    writeFileSync(path.join(root, file), source)

    const baseline = designSourceQualityBaseline(root)
    expect(baseline).toEqual([])
    expect(() => validateDesignSourceQuality(root, [file], baseline)).not.toThrow()

    writeFileSync(
      path.join(root, file),
      `${source}<style>.feature-card { border-left: 3px solid red; }</style><svg></svg>`,
    )
    expect(() => validateDesignSourceQuality(root, [file], baseline)).toThrow(
      'one-sided card-edge border',
    )
    expect(() => validateDesignSourceQuality(root, [file], baseline)).toThrow(
      'unmanifested inline SVG substitute',
    )
  })

  it('fingerprints separate self-closing SVGs and the full unmatched SVG tail', () => {
    const root = workspace()
    const file = path.join(root, 'App.tsx')
    writeFileSync(file, '<svg /> <svg />')
    expect(designSourceQualityBaseline(root)).toHaveLength(2)
    writeFileSync(file, '<svg>' + 'x'.repeat(2_000))
    const baseline = designSourceQualityBaseline(root)
    writeFileSync(file, '<svg>' + 'x'.repeat(2_000) + '<svg />')
    expect(() => validateDesignSourceQuality(root, [], baseline)).toThrow('SVG substitute')
  })

  it('accepts a source file at the 32 MB scan limit', () => {
    const root = workspace()
    const file = path.join(root, 'index.html')
    writeFileSync(file, '')
    truncateSync(file, 32_000_000)
    expect(designSourceQualityBaseline(root)).toEqual([])
  })

  it('rejects a file over the scan limit before reading it', () => {
    const root = workspace()
    const file = path.join(root, 'index.html')
    writeFileSync(file, '')
    truncateSync(file, 32_000_001)
    expect(() => designSourceQualityBaseline(root)).toThrow('exceeds 32000000 bytes')
  })

  it('keeps the total source scan bounded across large files', () => {
    const root = workspace()
    for (const name of ['desktop.html', 'mobile.html']) {
      const file = path.join(root, name)
      writeFileSync(file, '')
      truncateSync(file, 16_000_001)
    }
    expect(() => designSourceQualityBaseline(root)).toThrow('Design source scan exceeds 32 MB')
  })
})
