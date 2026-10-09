import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDashboardBrief, type DesignBrief } from './brief.js'
import { WEBSITE_LAYOUT_FAMILIES } from './page.js'
import { referenceDirectionAttachments } from './reference-directions.js'
import { readRasterMetadata } from './raster-metadata.js'
import {
  loadReviewedReferences,
  parseReferenceDeck,
  referenceLibraryRoot,
  referenceCandidatesForFamily,
  selectReviewedReferences,
} from './reference-library.js'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
function library() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'taste-references-')))
  roots.push(root)
  copyFileSync(
    fileURLToPath(new URL('../references/directions/hero/direction-001.webp', import.meta.url)),
    path.join(root, 'hero.webp'),
  )
  return root
}
const entry = {
  id: 'studio-hero',
  family: 'hero',
  cue: 'Centered portrait collage.',
  imagePath: 'hero.webp',
  source: 'https://example.com/studio',
  group: 'studio-hero',
  tags: ['studio', 'photographic'],
  reviewStatus: 'reviewed',
  reviewNotes: 'Desktop composition inspected; no mobile pair.',
}
const brief = {
  originalRequest: 'Build a studio site',
  subject: 'Studio',
  brandInputs: [],
  requiredContent: [],
} as unknown as DesignBrief
function save(root: string, references: unknown[]) {
  writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ version: 1, references }))
}
describe('reviewed reference library', () => {
  it('selects the bundled library on a fresh install without machine-specific configuration', () => {
    vi.stubEnv('TASTECODE_REFERENCE_LIBRARY', undefined)
    vi.spyOn(os, 'homedir').mockReturnValue(library())
    const references = loadReviewedReferences()
    expect(referenceLibraryRoot()).toBe(
      fileURLToPath(new URL('../references/library/', import.meta.url)),
    )
    expect(references).toHaveLength(372)
    expect(references.filter(({ family }) => family === 'hero')).toHaveLength(24)
    expect(references.filter(({ mobileImagePath }) => mobileImagePath)).toHaveLength(344)
    const websiteDeck = selectReviewedReferences(brief, references)
    expect(websiteDeck).toHaveLength(14)
    expect(websiteDeck.some(({ family }) => family === 'dashboard')).toBe(false)
    for (const family of WEBSITE_LAYOUT_FAMILIES) {
      const pool = referenceCandidatesForFamily(family, references)
      expect(
        new Set(pool.map((entry) => entry.group ?? entry.id)).size,
        family,
      ).toBeGreaterThanOrEqual(10)
      expect(new Set(pool.map((entry) => entry.imagePath)).size, family).toBeGreaterThanOrEqual(10)
    }

    const custom = library()
    save(custom, [entry])
    vi.stubEnv('TASTECODE_REFERENCE_LIBRARY', custom)
    expect(loadReviewedReferences().map(({ id }) => id)).toEqual(['studio-hero'])
    vi.stubEnv('TASTECODE_REFERENCE_LIBRARY', undefined)
    const configDirectory = path.join(os.homedir(), '.tastecode')
    mkdirSync(configDirectory)
    writeFileSync(
      path.join(configDirectory, 'design-references.json'),
      JSON.stringify({ libraryPath: custom }),
    )
    expect(loadReviewedReferences().map(({ id }) => id)).toEqual(['studio-hero'])
  })

  it('makes every bundled dashboard pair selectable and preserves its two verified raster attachments', () => {
    vi.stubEnv('TASTECODE_REFERENCE_LIBRARY', undefined)
    vi.spyOn(os, 'homedir').mockReturnValue(library())
    const references = loadReviewedReferences()
    const dashboards = references.filter(({ family }) => family === 'dashboard')
    expect(dashboards).toHaveLength(200)
    expect(new Set(dashboards.map(({ group }) => group)).size).toBe(200)
    const appBrief = {
      ...brief,
      pageType: 'mobile fitness app',
      originalRequest: 'Build a mobile fitness app',
    }
    const selectedGroups = new Set<string>()
    const images = new Set<string>()
    for (let index = 0; index < dashboards.length; index++) {
      const deck = selectReviewedReferences(appBrief, references, (length) =>
        length === dashboards.length ? index : 0,
      )
      expect(deck).toHaveLength(1)
      expect(deck[0]?.family).toBe('dashboard')
      selectedGroups.add(deck[0]!.group!)
      expect(parseReferenceDeck(deck)).toEqual(deck)
      const attachments = referenceDirectionAttachments(deck)
      expect(attachments).toHaveLength(2)
      for (const attachment of attachments) {
        images.add(attachment)
        expect(readRasterMetadata(attachment).format).toBe('webp')
      }
    }
    expect(selectedGroups.size).toBe(200)
    expect(images.size).toBe(400)
  })

  it('makes every hero group eligible despite different source sites, styles and revision counts', () => {
    const root = library()
    save(
      root,
      Array.from({ length: 10 }, (_, index) => ({
        ...entry,
        id: `hero-${index}`,
        group: `hero-${index}`,
        source: `https://example.com/${index}`,
        tags: index === 0 ? ['studio', 'photographic'] : ['unrelated'],
      })),
    )
    const references = loadReviewedReferences(root)
    references.push({ ...references[0]!, id: 'hero-0-revision' })
    const seen = Array.from(
      { length: 10 },
      (_, index) =>
        selectReviewedReferences(brief, references, (length) => (length === 10 ? index : 0))[0]!
          .group,
    )
    expect(new Set(seen).size).toBe(10)
  })

  it('loads paired generated dashboards separately and keeps random group votes and explicit choices', () => {
    const root = library()
    save(root, [entry, { ...entry, id: 'tiny-heading', tags: ['native-component'] }])
    const dashboardEntries = Array.from({ length: 3 }, (_, index) => ({
      ...entry,
      id: `dashboard-${index}`,
      family: 'dashboard',
      group: `dashboard-${index}`,
      assetType: 'generated-reference',
      mobileImagePath: 'hero.webp',
      pairEvidence: 'Both views preserve the same toolbar and data regions.',
    }))
    writeFileSync(
      path.join(root, 'dashboard-catalog.json'),
      JSON.stringify({
        version: 1,
        references: [
          ...dashboardEntries,
          { ...dashboardEntries[0], id: 'dashboard-revision' },
          { ...dashboardEntries[0], id: 'unreviewed-app', reviewStatus: 'candidate' },
          { ...dashboardEntries[0], id: 'screenshot-app', assetType: 'screenshot' },
          { ...dashboardEntries[0], id: 'unpaired-app', mobileImagePath: undefined },
        ],
      }),
    )
    const references = loadReviewedReferences(root)
    expect(references).toHaveLength(6)
    const appBrief = {
      ...brief,
      pageType: 'fitness app',
      originalRequest: 'Build a mobile fitness app',
    }
    const groups = Array.from({ length: 3 }, (_, index) => {
      const deck = selectReviewedReferences(appBrief, references, (length) =>
        length === 3 ? index : 0,
      )
      expect(deck).toHaveLength(1)
      expect(parseReferenceDeck(deck)).toEqual(deck)
      expect(deck[0]?.family).toBe('dashboard')
      return deck[0]?.group
    })
    expect(new Set(groups).size).toBe(3)
    expect(selectReviewedReferences(brief, references, () => 0).map(({ id }) => id)).toEqual([
      'studio-hero',
    ])
    expect(
      selectReviewedReferences(
        { ...appBrief, originalRequest: 'Use dashboard-2' },
        references,
        () => 0,
      )[0]?.id,
    ).toBe('dashboard-2')
    expect(() =>
      selectReviewedReferences(
        appBrief,
        references.filter(({ family }) => family !== 'dashboard'),
      ),
    ).toThrow('No reviewed dashboard references')
  })

  it('classifies the requested surface rather than dashboard products advertised on websites', () => {
    expect(isDashboardBrief({ ...brief, pageType: 'Dashboard' })).toBe(true)
    expect(isDashboardBrief({ ...brief, pageType: 'product_interface' })).toBe(true)
    expect(
      isDashboardBrief({
        ...brief,
        pageType: '',
        originalRequest: 'Create an analytics dashboard',
      }),
    ).toBe(true)
    expect(
      isDashboardBrief({
        ...brief,
        pageType: 'Landing page',
        originalRequest: 'Promote our analytics dashboard',
      }),
    ).toBe(false)
    expect(
      isDashboardBrief({
        ...brief,
        pageType: '',
        originalRequest: 'Build a landing page for a dashboard product',
      }),
    ).toBe(false)
  })

  it.each([
    ['mobile fitness app', 'Build a mobile fitness app'],
    ['web analytics app', 'Build a web analytics app'],
    ['desktop music app', 'Build a desktop music app'],
    ['Fitness-App', 'Erstelle eine Fitness-App'],
    ['webapp', 'Build a finance webapp'],
  ])(
    'selects dashboard references for a %s, including an unclassified prompt',
    (pageType, originalRequest) => {
      expect(isDashboardBrief({ pageType, originalRequest })).toBe(true)
      expect(isDashboardBrief({ pageType: '', originalRequest })).toBe(true)
    },
  )

  it.each([
    'Build a landing page for a mobile fitness app',
    'Build a landingpage for a web analytics app',
    'Build a website for a desktop music app',
    'Erstelle eine Landingpage für eine Fitness-App',
    'Build an apparel catalog',
  ])('keeps website references for %s', (originalRequest) => {
    expect(isDashboardBrief({ pageType: '', originalRequest })).toBe(false)
  })

  it.each(['Landingpage', 'App landing page', 'Website for a fitness app'])(
    'prioritizes the explicit marketing page type %s over app language',
    (pageType) => {
      expect(isDashboardBrief({ pageType, originalRequest: 'Build a mobile fitness app' })).toBe(
        false,
      )
    },
  )

  it('indexes complete generated candidates without claiming visual approval or resurrecting rejected entries', () => {
    const root = library()
    const site = path.join(root, 'new-studio')
    const generated = path.join(site, 'generated')
    mkdirSync(generated, { recursive: true })
    writeFileSync(
      path.join(site, 'manifest.json'),
      JSON.stringify({
        url: 'https://example.com/new',
        sections: ['hero', { order: 2, label: 'services', status: 'revision-needed' }],
      }),
    )
    for (const name of [
      '01-hero-desktop',
      '01-hero-desktop-full',
      '01-hero-mobile',
      '01-hero-mobile-v2',
      '01-hero-lower-02-about-desktop',
      '02-services-desktop',
      '03-about-desktop-1',
      '04-work-desktop',
      'threshold-hero-desktop',
    ])
      copyFileSync(path.join(root, 'hero.webp'), path.join(generated, `${name}.webp`))
    save(root, [entry, { ...entry, id: 'new-studio-04-work', reviewStatus: 'rejected' }])
    const references = loadReviewedReferences(root)
    expect(references.map(({ id }) => id)).toEqual(['studio-hero', 'new-studio-01-hero'])
    expect(references[1]?.imagePath).toBe(path.join(generated, '01-hero-desktop-full.webp'))
    expect(references[1]?.mobileImagePath).toBe(path.join(generated, '01-hero-mobile-v2.webp'))
    expect(references[1]?.cue).toContain('Visual review is pending')
    expect(references[1]?.cue).toContain('not a verified responsive match')
  })

  it('samples repeated content families without replacement', () => {
    const root = library()
    save(
      root,
      Array.from({ length: 4 }, (_, index) => ({
        ...entry,
        id: `feature-${index}`,
        group: `feature-${index}`,
        family: 'feature',
      })),
    )
    const selected = selectReviewedReferences(brief, loadReviewedReferences(root), () => 0)
    expect(selected.map(({ id }) => id)).toEqual(['feature-0', 'feature-1', 'feature-2'])
  })

  it('deduplicates revisions, discovers additions, and preserves explicit selections', () => {
    const root = library()
    save(root, [
      entry,
      { ...entry, id: 'studio-hero-revision' },
      { ...entry, id: 'bad', reviewStatus: 'rejected', imagePath: 'missing.png' },
    ])
    expect(
      selectReviewedReferences(brief, loadReviewedReferences(root), () => 0).map((item) => item.id),
    ).toEqual(['studio-hero'])
    const shop = {
      ...entry,
      id: 'shop-hero',
      group: 'shop-hero',
      source: 'https://example.com/shop',
      tags: ['commerce', 'products'],
    }
    save(root, [entry, shop])
    expect(
      selectReviewedReferences(
        { ...brief, originalRequest: 'Build commerce products shop' },
        loadReviewedReferences(root),
        (length) => length - 1,
      )[0]?.id,
    ).toBe('shop-hero')
    expect(
      selectReviewedReferences(
        { ...brief, originalRequest: 'Use shop-hero for this studio' },
        loadReviewedReferences(root),
      )[0]?.id,
    ).toBe('shop-hero')
  })
  it('matches an explicitly named reference id only as a whole token', () => {
    const root = library()
    const ids = ['studio-hero', 'studio-hero-process', 'hero-band', 'x-hero-band']
    save(
      root,
      ids.map((id) => ({ ...entry, id, group: id })),
    )
    const references = loadReviewedReferences(root)
    const pick = (originalRequest: string) =>
      selectReviewedReferences({ ...brief, originalRequest }, references, () => 0)[0]?.id
    expect(pick('Use studio-hero-process for the opening')).toBe('studio-hero-process')
    expect(pick('Use x-hero-band for the opening')).toBe('x-hero-band')
    expect(pick('Use hero-band.')).toBe('hero-band')
    expect(pick('Hero: STUDIO-HERO, please')).toBe('studio-hero')
  })
  it('matches an explicitly named source URL regardless of scheme, host case and trailing slash', () => {
    const root = library()
    save(root, [
      entry,
      { ...entry, id: 'second-hero', group: 'second-hero', source: 'https://example.com/second/' },
    ])
    const references = loadReviewedReferences(root)
    const pick = (originalRequest: string, chooseIndex: (length: number) => number) =>
      selectReviewedReferences({ ...brief, originalRequest }, references, chooseIndex)[0]?.id
    const first = () => 0
    const last = (length: number) => length - 1
    expect(pick('Model the hero on https://example.com/second', first)).toBe('second-hero')
    expect(pick('Model the hero on http://EXAMPLE.com/second/.', first)).toBe('second-hero')
    expect(pick('Model the hero on https://example.com/studio/', last)).toBe('studio-hero')
    expect(pick('Model the hero on https://example.com/studio-two', last)).toBe('second-hero')
    expect(pick('Model the hero on https://example.com/studio/team', last)).toBe('second-hero')
  })
  it('randomly chooses suitable groups while honoring an explicitly requested reference', () => {
    const root = library()
    save(root, [entry, { ...entry, id: 'second-hero', group: 'second-hero' }])
    const references = loadReviewedReferences(root)
    const first = selectReviewedReferences(brief, references, () => 0)[0]?.id
    const last = selectReviewedReferences(brief, references, (length) => length - 1)[0]?.id
    expect(first).not.toBe(last)
    expect(
      selectReviewedReferences(
        {
          ...brief,
          brandInputs: ['Use studio-hero'],
          assumptions: ['Use https://example.com/studio'],
        },
        references,
        (length) => length - 1,
      )[0]?.id,
    ).toBe(last)
    expect(
      selectReviewedReferences(
        { ...brief, originalRequest: 'Use studio-hero' },
        references,
        (length) => length - 1,
      )[0]?.id,
    ).toBe('studio-hero')
    expect(() => selectReviewedReferences(brief, [])).toThrow('No Design references')
  })
  it('requires real reviewed files and pairing evidence; threshold files stay excluded', () => {
    const root = library()
    save(root, [{ ...entry, mobileImagePath: 'hero.webp' }])
    expect(() => loadReviewedReferences(root)).toThrow('pairEvidence')
    save(root, [
      { ...entry, mobileImagePath: 'hero.webp', pairEvidence: 'Both viewports inspected.' },
    ])
    expect(loadReviewedReferences(root)[0]?.mobileImagePath).toBe(path.join(root, 'hero.webp'))
    save(root, [{ ...entry, imagePath: '../escape.png' }])
    expect(() => loadReviewedReferences(root)).toThrow('inside the workspace')
    save(root, [{ ...entry, imagePath: 'missing.png' }])
    expect(() => loadReviewedReferences(root)).toThrow('does not exist')
    save(root, [{ ...entry, imagePath: 'threshold-hero.png' }])
    expect(() => loadReviewedReferences(root)).toThrow(
      'no reviewed or generated reference candidates',
    )
  })
  it('keeps the composition deck complete for free-form section names', () => {
    const root = library()
    save(root, [entry, { ...entry, id: 'studio-stats', group: 'studio-stats', family: 'stats' }])
    expect(
      selectReviewedReferences(
        {
          ...brief,
          requiredContent: ['Opening promise: a studio', 'Closing invitation: get in touch'],
        },
        loadReviewedReferences(root),
      ).map(({ family }) => family),
    ).toEqual(['hero', 'stats'])
  })
  it('keeps requested sections when the preferred collection lacks their family', () => {
    const root = library()
    save(root, [
      entry,
      {
        ...entry,
        id: 'editorial-about',
        group: 'editorial-about',
        family: 'about',
        source: 'https://example.com/editorial',
        tags: ['serif'],
      },
    ])
    expect(
      selectReviewedReferences(
        { ...brief, requiredContent: ['Hero', 'About introduction'] },
        loadReviewedReferences(root),
        () => 0,
      ).map(({ family }) => family),
    ).toEqual(['hero', 'about'])
  })
  it('allows content topics without a dedicated catalog family', () => {
    const root = library()
    save(root, [entry])
    const references = loadReviewedReferences(root)
    expect(
      selectReviewedReferences(
        { ...brief, requiredContent: ['Hero: describe the service and process'] },
        references,
      ),
    ).toHaveLength(1)
    expect(
      selectReviewedReferences({ ...brief, requiredContent: ['Hero', 'Pricing'] }, references),
    ).toHaveLength(1)
  })
  it('rejects duplicate identifiers and corrupt selected images with actionable errors', () => {
    const root = library()
    save(root, [entry, entry])
    expect(() => loadReviewedReferences(root)).toThrow('duplicate reference IDs')
    expect(() => parseReferenceDeck([entry, entry])).toThrow('duplicate')
    save(root, [entry])
    writeFileSync(path.join(root, 'hero.webp'), 'not an image')
    expect(() => selectReviewedReferences(brief, loadReviewedReferences(root))).toThrow()
    writeFileSync(path.join(root, 'catalog.json'), '{')
    expect(() => loadReviewedReferences(root)).toThrow('Repair catalog.json')
  })
})
