import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AssetManifest, DesignAsset } from './assets.js'
import type { BrandSystem } from './brand.js'
import type { PageBlueprint } from './page.js'
import { DESIGN_FONT_POOLS } from './typography.js'

/**
 * Brand typefaces, downloaded by TasteCode itself before the Asset phase. A provider's sandbox
 * may block the network for the agent's own commands: a real Codex run could not download Syne
 * in three Asset passes, so Build later stopped on the missing font. Every family in the design
 * font pools is a Google Font, so TasteCode fetches its WOFF2 files and licence once, into the
 * project, and records them in the manifest itself.
 */
export const BRAND_FONT_DIRECTORY = 'assets/fonts'

const CSS_API = 'https://fonts.googleapis.com/css2'
const REPOSITORY = 'https://raw.githubusercontent.com/google/fonts/main'
/** Google Fonts serves WOFF2 only to a browser that reads it. */
const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
/** The subsets a page in a Latin script needs; others are left out to keep the page light. */
const SUBSETS = new Set(['latin', 'latin-ext'])
const MAX_FONT_BYTES = 2_000_000
const LICENSES = [
  { directory: 'ofl', file: 'OFL.txt', name: 'SIL Open Font License 1.1' },
  { directory: 'apache', file: 'LICENSE.txt', name: 'Apache License 2.0' },
  { directory: 'ufl', file: 'UFL.txt', name: 'Ubuntu Font Licence 1.0' },
] as const

export type BrandFont =
  | {
      family: string
      status: 'ready'
      /** The family's folder, workspace-relative. */
      folder: string
      files: string[]
      license: string
      licenseName: string
      stylesheet: string
    }
  | { family: string; status: 'failed'; reason: string }

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>

type Typeface = BrandSystem['typefaces'][number]

const POOLED = new Set<string>(Object.values(DESIGN_FONT_POOLS).flat())

/**
 * A family TasteCode can fetch: one of the design font pools, or one whose source names Google
 * Fonts. A system face or an existing brand's own font stays the agent's and the user's.
 */
export function isGoogleFont({ family, source }: Pick<Typeface, 'family' | 'source'>): boolean {
  return POOLED.has(family) || /fonts\.google|google ?fonts/i.test(source)
}

export function brandFontSlug(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Download every brand typeface that is not in the project yet; never throws. */
export async function acquireBrandFonts(
  brand: Pick<BrandSystem, 'typefaces'>,
  workspacePath: string,
  fetchImpl: Fetch = fetch,
): Promise<BrandFont[]> {
  const fonts: BrandFont[] = []
  for (const typeface of brand.typefaces.filter(isGoogleFont)) {
    const local = localBrandFont(typeface.family, workspacePath)
    if (local) {
      fonts.push(local)
      continue
    }
    try {
      fonts.push(await downloadFamily(typeface.family, typeface.weights, workspacePath, fetchImpl))
    } catch (error) {
      fonts.push({
        family: typeface.family,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return fonts
}

/** The brand typefaces already in the project's font folder, from an earlier download. */
export function localBrandFonts(
  brand: Pick<BrandSystem, 'typefaces'>,
  workspacePath: string,
): BrandFont[] {
  return brand.typefaces.filter(isGoogleFont).map(
    ({ family }) =>
      localBrandFont(family, workspacePath) ?? {
        family,
        status: 'failed',
        reason: 'not downloaded yet',
      },
  )
}

function localBrandFont(family: string, workspacePath: string): BrandFont | undefined {
  const slug = brandFontSlug(family)
  const folder = `${BRAND_FONT_DIRECTORY}/${slug}`
  const absolute = path.join(workspacePath, ...folder.split('/'))
  if (!existsSync(absolute)) return undefined
  const names = readdirSync(absolute)
  const files = names.filter((name) => name.endsWith('.woff2')).sort()
  const license = LICENSES.find(({ file }) => names.includes(file))
  if (!files.length || !license || !names.includes(`${slug}.css`)) return undefined
  return {
    family,
    status: 'ready',
    folder,
    files: files.map((name) => `${folder}/${name}`),
    license: `${folder}/${license.file}`,
    licenseName: license.name,
    stylesheet: `${folder}/${slug}.css`,
  }
}

interface FontFace {
  subset: string
  style: string
  weight: string
  url: string
  unicodeRange: string | undefined
}

/** The @font-face blocks of a Google Fonts CSS2 answer, each labelled with its subset. */
export function parseGoogleFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = []
  for (const match of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    const body = match[2] ?? ''
    const url = /src:\s*url\(([^)]+)\)\s*format\(['"]woff2['"]\)/.exec(body)?.[1]
    if (!url) continue
    faces.push({
      subset: match[1] ?? '',
      style: /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal',
      weight: /font-weight:\s*([\d ]+)/.exec(body)?.[1]?.trim() ?? '400',
      url: url.replace(/^['"]|['"]$/g, ''),
      unicodeRange: /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim(),
    })
  }
  return faces
}

async function downloadFamily(
  family: string,
  weights: readonly number[],
  workspacePath: string,
  fetchImpl: Fetch,
): Promise<BrandFont> {
  const css = await googleCss(family, weights, fetchImpl)
  const faces = parseGoogleFontFaces(css).filter(({ style }) => style === 'normal')
  const latin = faces.filter(({ subset }) => SUBSETS.has(subset))
  const chosen = latin.length ? latin : faces
  if (!chosen.length) throw new Error(`Google Fonts returned no WOFF2 files for ${family}`)

  const slug = brandFontSlug(family)
  const folder = `${BRAND_FONT_DIRECTORY}/${slug}`
  // A variable family answers every weight with one file; fetch each file once.
  const fileByUrl = new Map<string, { name: string; body: Buffer }>()
  for (const face of chosen) {
    if (fileByUrl.has(face.url)) continue
    const response = await fetchImpl(face.url, { headers: { 'User-Agent': BROWSER } })
    if (!response.ok) throw new Error(`${face.url} answered ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    if (body.subarray(0, 4).toString('latin1') !== 'wOF2' || body.length > MAX_FONT_BYTES)
      throw new Error(`${face.url} is not a WOFF2 font file`)
    fileByUrl.set(face.url, {
      name: `${slug}-${face.weight.split(' ')[0]}-${face.subset}.woff2`,
      body,
    })
  }
  const license = await googleLicense(family, fetchImpl)

  const stylesheet = chosen
    .map((face) =>
      [
        '@font-face {',
        `  font-family: '${family}';`,
        `  font-style: ${face.style};`,
        `  font-weight: ${face.weight};`,
        '  font-display: swap;',
        `  src: url('./${fileByUrl.get(face.url)!.name}') format('woff2');`,
        ...(face.unicodeRange ? [`  unicode-range: ${face.unicodeRange};`] : []),
        '}',
      ].join('\n'),
    )
    .join('\n\n')

  // Write next to the final folder and move it in whole, so a failed download leaves nothing.
  const target = path.join(workspacePath, ...folder.split('/'))
  const staging = `${target}.download-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    for (const { name, body } of fileByUrl.values()) writeFileSync(path.join(staging, name), body)
    writeFileSync(path.join(staging, license.file), license.text)
    writeFileSync(
      path.join(staging, `${slug}.css`),
      `/* ${family}, self-hosted from Google Fonts by TasteCode. ${license.name}: ${license.file}. */\n\n${stylesheet}\n`,
    )
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  const local = localBrandFont(family, workspacePath)
  if (!local) throw new Error(`${family} did not land in ${folder}`)
  return local
}

async function googleCss(family: string, weights: readonly number[], fetchImpl: Fetch) {
  const name = family.trim().replace(/ +/g, '+')
  const axis = [...new Set(weights)].sort((a, b) => a - b).join(';')
  const urls = [
    `${CSS_API}?family=${name}:wght@${axis}&display=swap`,
    `${CSS_API}?family=${name}&display=swap`,
  ]
  let last = ''
  for (const url of urls) {
    const response = await fetchImpl(url, { headers: { 'User-Agent': BROWSER } })
    if (response.ok) return response.text()
    // A weight the family does not have answers 400; the family's default face still serves.
    last = `${url} answered ${response.status}`
  }
  throw new Error(last)
}

async function googleLicense(family: string, fetchImpl: Fetch) {
  const repository = family.toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const license of LICENSES) {
    const response = await fetchImpl(
      `${REPOSITORY}/${license.directory}/${repository}/${license.file}`,
    )
    if (response.ok) return { ...license, text: await response.text() }
  }
  throw new Error(`no licence for ${family} in google/fonts`)
}

/** Manifest records for the brand fonts TasteCode downloaded, used by every page section. */
export function brandFontRecords(fonts: readonly BrandFont[], page: PageBlueprint): DesignAsset[] {
  return fonts.flatMap((font) =>
    font.status === 'ready'
      ? [
          {
            id: `brand_font_${brandFontSlug(font.family).replaceAll('-', '_')}`,
            kind: 'font' as const,
            status: 'ready' as const,
            purpose: `${font.family}, the approved brand typeface, self-hosted in ${font.folder} with ${font.stylesheet}.`,
            requirements: [
              `Load ${font.stylesheet}; it declares every @font-face for ${font.family}.`,
            ],
            role: 'font' as const,
            sectionIds: page.sections.map(({ id }) => id),
            source: {
              kind: 'external' as const,
              reference: `https://fonts.google.com/specimen/${font.family.trim().replace(/ +/g, '+')}`,
              license: `${font.licenseName}, ${font.license}`,
              contentType: 'font/woff2',
            },
            destination: font.folder,
          },
        ]
      : [],
  )
}

function namesFamily(asset: DesignAsset, family: string): boolean {
  const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = compact(family)
  return [asset.id, asset.purpose, asset.destination ?? '', asset.source?.reference ?? ''].some(
    (text) => compact(text).includes(wanted),
  )
}

/**
 * The manifest with TasteCode's records for the fonts it downloaded, in place of any font record
 * the agent wrote for those families.
 */
export function withBrandFonts(
  manifest: AssetManifest,
  fonts: readonly BrandFont[],
  page: PageBlueprint,
): AssetManifest {
  const ready = fonts.filter(({ status }) => status === 'ready')
  const records = brandFontRecords(ready, page)
  if (!records.length) return manifest
  const replaced = (asset: DesignAsset) =>
    asset.kind === 'font' && ready.some(({ family }) => namesFamily(asset, family))
  const kept = manifest.assets.filter((asset) => !replaced(asset))
  return {
    ...manifest,
    assets: [
      ...kept,
      ...records.map((record, index) => {
        // Keep the ID of the record it replaces: Page may list it as a font need of its own.
        const earlier = manifest.assets.find(
          (asset) => replaced(asset) && namesFamily(asset, ready[index]!.family),
        )?.id
        if (!earlier) return record
        // A font Page listed as a need serves exactly the sections that list it.
        const listing = page.sections.filter(({ assetNeeds }) => assetNeeds.includes(earlier))
        return {
          ...record,
          id: earlier,
          ...(listing.length ? { sectionIds: listing.map(({ id }) => id) } : {}),
        }
      }),
    ],
  }
}

/**
 * Every brand typeface has a local font file before Build. Build cannot load a font that is
 * missing, and finding that out there cost a real run its last 15 minutes.
 */
export function validateBrandFontsResolved(
  manifest: AssetManifest,
  brand: Pick<BrandSystem, 'typefaces'>,
  fonts: readonly BrandFont[] = [],
): void {
  const missing = brand.typefaces
    .filter(isGoogleFont)
    .map(({ family }) => family)
    .filter(
      (family) =>
        !manifest.assets.some(
          (asset) =>
            asset.kind === 'font' &&
            (asset.status === 'ready' || asset.status === 'existing') &&
            asset.destination !== undefined &&
            namesFamily(asset, family),
        ),
    )
  if (!missing.length) return
  const reasons = missing.map((family) => {
    const font = fonts.find((entry) => entry.family === family)
    return font?.status === 'failed'
      ? `${family} (TasteCode could not download it: ${font.reason})`
      : family
  })
  throw new Error(
    `Brand typefaces without a local font file: ${reasons.join('; ')}. Acquire each one as a real WOFF2, WOFF, TTF or OTF file with its licence inside the project and record it with status ready.`,
  )
}
