import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { designAssetPrompt } from './asset-phase.js'
import { parseAssetManifest, validateAssetManifestForPage } from './assets.js'
import {
  acquireBrandFonts,
  localBrandFonts,
  parseGoogleFontFaces,
  validateBrandFontsResolved,
  withBrandFonts,
} from './brand-fonts.js'

const workspaces: string[] = []
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'design-brand-fonts-'))
  workspaces.push(dir)
  return dir
}

const brand = {
  typefaces: [{ family: 'Syne', source: 'Google Fonts', roles: ['all'], weights: [400, 700] }],
}
const page = {
  sections: [
    { id: 'hero', assetNeeds: ['syne_font'], componentNeeds: [] },
    { id: 'visit', assetNeeds: [], componentNeeds: [] },
  ],
} as unknown as Parameters<typeof validateAssetManifestForPage>[1]

// The shape Google Fonts answers for a variable family: one file per subset serves every weight.
const css = ['latin-ext', 'latin', 'cyrillic']
  .flatMap((subset) =>
    [400, 700].map(
      (weight) => `/* ${subset} */
@font-face {
  font-family: 'Syne';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/syne/v22/${subset}.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`,
    ),
  )
  .join('\n')
// A WOFF2 header: its signature, and its own length at byte 8.
const woff2 = Buffer.alloc(64)
woff2.write('wOF2', 0, 'latin1')
woff2.writeUInt32BE(64, 8)

function googleFonts() {
  const asked: string[] = []
  const fetchImpl = async (url: string) => {
    asked.push(url)
    if (url.startsWith('https://fonts.googleapis.com/css2')) return new Response(css)
    if (url.startsWith('https://fonts.gstatic.com/')) return new Response(woff2)
    if (url.endsWith('/ofl/syne/OFL.txt')) return new Response('SIL Open Font License 1.1 for Syne')
    return new Response('not found', { status: 404 })
  }
  return { asked, fetchImpl }
}

describe('brand fonts', () => {
  it('reads the labelled @font-face blocks Google Fonts answers', () => {
    const faces = parseGoogleFontFaces(css)
    expect(faces).toHaveLength(6)
    expect(faces[0]).toMatchObject({ subset: 'latin-ext', weight: '400', style: 'normal' })
  })

  it('self-hosts the Latin files, the licence and one stylesheet, once', async () => {
    const dir = workspace()
    const { asked, fetchImpl } = googleFonts()
    const [font] = await acquireBrandFonts(brand, dir, fetchImpl)
    expect(font).toMatchObject({ family: 'Syne', status: 'ready', folder: 'assets/fonts/syne' })
    const folder = path.join(dir, 'assets', 'fonts', 'syne')
    expect(readdirSync(folder).sort()).toEqual([
      'OFL.txt',
      'syne-400-latin-ext.woff2',
      'syne-400-latin.woff2',
      'syne.css',
    ])
    const stylesheet = readFileSync(path.join(folder, 'syne.css'), 'utf8')
    expect(stylesheet).toContain("src: url('./syne-400-latin.woff2') format('woff2');")
    expect(stylesheet).toContain('font-weight: 700;')
    expect(asked.filter((url) => url.includes('gstatic'))).toHaveLength(2)
    expect(asked.some((url) => url.includes('cyrillic'))).toBe(false)

    // A second run finds the folder and fetches nothing.
    asked.length = 0
    await acquireBrandFonts(brand, dir, fetchImpl)
    expect(asked).toEqual([])
  })

  it('reports a failed download and leaves nothing half-written', async () => {
    const dir = workspace()
    const offline = async (): Promise<Response> => {
      throw new TypeError('fetch failed')
    }
    const [font] = await acquireBrandFonts(brand, dir, offline)
    expect(font).toEqual({ family: 'Syne', status: 'failed', reason: 'fetch failed' })
    expect(existsSync(path.join(dir, 'assets'))).toBe(false)
  })

  it('records the downloaded family in place of the agent’s record and passes the Asset validation', async () => {
    const dir = workspace()
    const fonts = await acquireBrandFonts(brand, dir, googleFonts().fetchImpl)
    const agent = parseAssetManifest({
      version: 1,
      assets: [
        {
          id: 'syne_font',
          kind: 'font',
          role: 'font',
          status: 'needed',
          purpose: 'Syne brand typeface; the download was blocked.',
          requirements: ['Download Syne'],
          sectionIds: ['hero'],
        },
      ],
    })
    const merged = validateAssetManifestForPage(withBrandFonts(agent, fonts, page), page, dir)
    expect(merged.assets.map(({ id }) => id)).toEqual(['syne_font', 'syne_font_file_2'])
    expect(merged.assets.every(({ status }) => status === 'ready')).toBe(true)
    expect(merged.assets[0]?.source).toMatchObject({ kind: 'external', contentType: 'font/woff2' })
    expect(() => validateBrandFontsResolved(merged, brand, fonts)).not.toThrow()
  })

  it('stops the Asset phase when a brand typeface has no local file', () => {
    const empty = parseAssetManifest({ version: 1, assets: [] })
    expect(() =>
      validateBrandFontsResolved(empty, brand, [
        { family: 'Syne', status: 'failed', reason: 'fetch failed' },
      ]),
    ).toThrow(/Syne \(TasteCode could not download it: fetch failed\)/)
  })

  it('tells the agent the fonts are handled, or asks it to get the ones TasteCode could not', async () => {
    const dir = workspace()
    const brief = {} as Parameters<typeof designAssetPrompt>[0]
    const fullBrand = brand as unknown as Parameters<typeof designAssetPrompt>[1]
    const pending = designAssetPrompt(brief, fullBrand, page, [], localBrandFonts(brand, dir))
    expect(pending).toContain('Acquire every approved brand typeface')
    const fonts = await acquireBrandFonts(brand, dir, googleFonts().fetchImpl)
    const ready = designAssetPrompt(brief, fullBrand, page, [], fonts)
    expect(ready).toContain('TasteCode already downloaded the approved typefaces Syne')
    expect(ready).not.toContain('Acquire every approved brand typeface')
    expect(ready).toContain('Preserve valid raster provenance metadata')
  })
})
