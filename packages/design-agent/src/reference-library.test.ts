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
import type { ReferenceStyleProfile, ReferenceStyleProfiles } from './reference-style-profiles.js'

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
function profiles(sites: Record<string, Partial<ReferenceStyleProfile>>): ReferenceStyleProfiles {
  return new Map(
    Object.entries(sites).map(([site, profile]) => [
      site,
      { mood: [], outliers: new Set<string>(), ...profile },
    ]),
  )
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
    expect(websiteDeck.map(({ role }) => role === 'anchor')).toEqual([
      true,
      ...Array(13).fill(false),
    ])
    expect(websiteDeck.every(({ site, role }) => site && role)).toBe(true)
    expect(Boolean(websiteDeck[0]!.style)).toBe(
      websiteDeck[0]!.site !== 'maestroclass.framer.website',
    )
    expect(parseReferenceDeck(websiteDeck)).toEqual(websiteDeck)
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
    // No domain words, so every bundled screen stays equally reachable.
    const appBrief = {
      ...brief,
      subject: 'Acme',
      pageType: 'mobile app',
      originalRequest: 'Build a mobile app',
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
    // A domain request narrows the same bundle to screens named for that domain.
    const financeDeck = selectReviewedReferences(
      { ...appBrief, originalRequest: 'Build a finance dashboard' },
      references,
      () => 0,
    )
    expect(financeDeck[0]?.tags?.join(' ')).toContain('financ')
    // Loading 372 references and decoding 400 rasters exceeds the default limit on a busy machine.
  }, 60_000)

  it('prefers dashboards named for the requested domain and stays uniform without a match', () => {
    const root = library()
    save(root, [entry])
    const dashboard = (
      id: string,
      domain: string,
      sourceName: string,
      cue: string,
      motifs?: string[],
    ) => ({
      ...entry,
      id,
      group: id,
      family: 'dashboard',
      tags: ['dashboard', 'full-screen', 'generated', domain],
      domain,
      sourceName,
      ...(motifs ? { motifs } : {}),
      cue,
      assetType: 'generated-reference',
      mobileImagePath: 'hero.webp',
      pairEvidence: 'Both views preserve the same toolbar and data regions.',
    })
    writeFileSync(
      path.join(root, 'dashboard-catalog.json'),
      JSON.stringify({
        version: 1,
        references: [
          dashboard('dash-ledger', 'finance', 'Ledgerly', 'Dense ledger table with balances.'),
          dashboard('dash-budget', 'business-finance', 'Budgeteer', 'Budget envelopes.'),
          dashboard('dash-notes', 'notes', 'Notely', 'Notes editor with a small finance widget.'),
          dashboard('dash-gym', 'fitness', 'Gymbook', 'Workout calendar.', ['heart-rate rings']),
        ],
      }),
    )
    const references = loadReviewedReferences(root)
    const reachable = (originalRequest: string, extra: Partial<DesignBrief> = {}) => {
      const seen = new Set<string>()
      for (let index = 0; index < 4; index++) {
        const deck = selectReviewedReferences(
          { ...brief, pageType: 'dashboard', originalRequest, ...extra },
          references,
          (length) => index % length,
        )
        expect(deck).toHaveLength(1)
        expect(deck[0]).not.toHaveProperty('relevance')
        expect(parseReferenceDeck(deck)).toEqual(deck)
        seen.add(deck[0]!.id)
      }
      return [...seen].sort()
    }
    // Domain and product names outweigh a passing mention in another screen's cue.
    expect(reachable('Build a finance dashboard')).toEqual(['dash-budget', 'dash-ledger'])
    expect(reachable('Build an app like Gymbook')).toEqual(['dash-gym'])
    expect(reachable('An app with heart-rate rings')).toEqual(['dash-gym'])
    expect(reachable('Build an app', { subject: 'Ledgerly clone' })).toEqual(['dash-ledger'])
    expect(reachable('Build an app', { requiredContent: ['Workout log'] })).toEqual(['dash-gym'])
    expect(reachable('Build an internal admin dashboard')).toEqual([
      'dash-budget',
      'dash-gym',
      'dash-ledger',
      'dash-notes',
    ])
    expect(reachable('Use dash-notes for our finance dashboard')).toEqual(['dash-notes'])
  })

  it('makes every hero group an equally eligible anchor despite source sites, profiles and revision counts', () => {
    const root = library()
    save(
      root,
      Array.from({ length: 10 }, (_, index) => ({
        ...entry,
        id: `hero-${index}`,
        group: `hero-${index}`,
        source: `https://site-${index}.example/`,
        tags: index === 0 ? ['studio', 'photographic'] : ['unrelated'],
      })),
    )
    const references = loadReviewedReferences(root)
    references.push({ ...references[0]!, id: 'hero-0-revision' })
    const styles = profiles({
      'site-0.example': { headingType: 'serif', summary: 'Serif studio.' },
      'site-1.example': { headingType: 'mono' },
    })
    const seen = Array.from({ length: 10 }, (_, index) => {
      const [anchor] = selectReviewedReferences(
        brief,
        references,
        (length) => (length === 10 ? index : 0),
        styles,
      )
      expect(anchor).toMatchObject({ role: 'anchor', site: `site-${index}.example` })
      expect(anchor?.style).toBe(index === 0 ? 'Serif studio.' : undefined)
      return anchor!.group
    })
    expect(new Set(seen).size).toBe(10)
  })

  it('fills later sections from the anchor site before any other source', () => {
    const root = library()
    const site = (name: string, id: string, family: string) => ({
      ...entry,
      id,
      group: id,
      family,
      source: `https://${name}.example/${id}`,
    })
    save(root, [
      site('b', 'b-hero', 'hero'),
      site('a', 'a-hero', 'hero'),
      site('a', 'a-about', 'about'),
      site('b', 'b-about-1', 'about'),
      site('b', 'b-about-2', 'about'),
      ...['a-feature-1', 'a-feature-2', 'a-feature-3', 'a-feature-4'].map((id) =>
        site('a', id, 'feature'),
      ),
      site('b', 'b-pricing', 'pricing'),
    ])
    const references = loadReviewedReferences(root)
    const last = (length: number) => length - 1
    const deck = selectReviewedReferences(brief, references, last, profiles({}))
    expect(deck.map(({ id, role }) => `${id}:${role}`)).toEqual([
      'a-hero:anchor',
      'a-about:same-site',
      'b-about-2:fallback',
      'a-feature-4:same-site',
      'a-feature-3:same-site',
      'a-feature-2:same-site',
      // The anchor site's compatible feature beats another site's native pricing.
      'a-feature-1:same-site',
    ])
    expect(deck.map(({ site }) => site)).toEqual([
      ...Array(2).fill('a.example'),
      'b.example',
      ...Array(4).fill('a.example'),
    ])
    expect(deck.at(-1)?.cue).toContain('Sampled for pricing content')
    expect(deck.at(-1)?.family).toBe('feature')
    expect(parseReferenceDeck(deck)).toEqual(deck)

    const explicit = selectReviewedReferences(
      { ...brief, originalRequest: 'Use b-about-1 for the about section' },
      references,
      last,
      profiles({}),
    )
    expect(explicit.filter(({ family }) => family === 'about')).toMatchObject([
      { id: 'b-about-1', role: 'fallback' },
    ])
  })

  it('falls back to the most similar profiled sites, ties included, before the uniform pool', () => {
    const root = library()
    const anchorStyle = {
      theme: 'light',
      headingType: 'serif',
      bodyType: 'grotesk-sans',
      radius: 'small',
      density: 'airy',
      imagery: 'photographic',
      mood: ['calm', 'editorial', 'warm'],
    }
    const styles = profiles({
      'anchor.example': { ...anchorStyle, summary: 'Calm serif editorial.' },
      's1.example': anchorStyle,
      's2.example': { theme: 'light', headingType: 'serif', bodyType: 'grotesk-sans' },
      's3.example': { theme: 'mixed', headingType: 'high-contrast-serif' },
      's4.example': { headingType: 'serif' },
      's5.example': { density: 'airy' },
      'dissimilar.example': { theme: 'dark', headingType: 'mono', bodyType: 'mono' },
    })
    save(root, [
      { ...entry, id: 'anchor-hero', group: 'anchor-hero', source: 'https://anchor.example/' },
      ...['s1', 's2', 's3', 's4', 's5', 'dissimilar', 'unprofiled'].map((name) => ({
        ...entry,
        id: `${name}-footer`,
        group: `${name}-footer`,
        family: 'footer',
        source: `https://${name}.example/`,
      })),
    ])
    const references = loadReviewedReferences(root)
    const pick = (chooseIndex: (length: number) => number) =>
      selectReviewedReferences(brief, references, chooseIndex, styles)
    const lastDeck = pick((length) => length - 1)
    expect(lastDeck[0]).toMatchObject({ id: 'anchor-hero', role: 'anchor' })
    expect(lastDeck[0]?.style).toBe('Calm serif editorial.')
    // s3 and s4 tie for third place, so both stay eligible; s5 ranks below the cut.
    expect(lastDeck[1]).toMatchObject({ id: 's4-footer', role: 'similar-site', site: 's4.example' })
    const reachable = new Set(
      [0, 1, 2, 3].map((index) => pick((length) => (length === 4 ? index : 0))[1]?.id),
    )
    expect(reachable).toEqual(new Set(['s1-footer', 's2-footer', 's3-footer', 's4-footer']))
    // Similar sites never take a slot from the anchor site itself.
    const withAnchorFooter = [
      ...references,
      {
        ...references[1]!,
        id: 'anchor-footer',
        group: 'anchor-footer',
        source: 'https://anchor.example/',
      },
    ]
    expect(selectReviewedReferences(brief, withAnchorFooter, () => 0, styles)[1]).toMatchObject({
      id: 'anchor-footer',
      role: 'same-site',
    })
  })

  it('never anchors on or extends the anchor site with its listed outliers', () => {
    const root = library()
    const site = (id: string, family: string, name = 'a') => ({
      ...entry,
      id,
      group: id,
      family,
      source: `https://${name}.example/`,
    })
    save(root, [
      site('a-hero', 'hero'),
      site('a-hero-odd', 'hero'),
      site('a-footer-odd', 'footer'),
      site('b-footer', 'footer', 'b'),
    ])
    const references = loadReviewedReferences(root)
    const styles = profiles({ 'a.example': { outliers: new Set(['a-hero-odd', 'a-footer-odd']) } })
    expect(
      selectReviewedReferences(brief, references, (length) => length - 1, styles).map(
        ({ id, role }) => `${id}:${role}`,
      ),
    ).toEqual(['a-hero:anchor', 'b-footer:fallback'])
    // The uniform fallback may still use an outlier; it just never counts as the same language.
    expect(
      selectReviewedReferences(brief, references, () => 0, styles).map(
        ({ id, role }) => `${id}:${role}`,
      ),
    ).toEqual(['a-hero:anchor', 'a-footer-odd:fallback'])
    // A library whose only heroes are outliers still gets a hero anchor.
    expect(
      selectReviewedReferences(
        brief,
        references.filter(({ id }) => id !== 'a-hero'),
        () => 0,
        styles,
      )[0],
    ).toMatchObject({ id: 'a-hero-odd', role: 'anchor' })
  })

  it('skips the similar-site tier when the anchor site has no profile', () => {
    const root = library()
    const site = (id: string, family: string, name: string) => ({
      ...entry,
      id,
      group: id,
      family,
      source: `https://${name}.example/`,
    })
    save(root, [
      site('u-hero', 'hero', 'u'),
      site('u-about', 'about', 'u'),
      site('p-about', 'about', 'p'),
      site('q-about', 'about', 'q'),
    ])
    const same = { theme: 'light', headingType: 'serif', mood: ['calm'] }
    const deck = selectReviewedReferences(
      brief,
      loadReviewedReferences(root),
      () => 0,
      profiles({ 'p.example': same, 'q.example': same }),
    )
    expect(deck.map(({ id, role }) => `${id}:${role}`)).toEqual([
      'u-hero:anchor',
      'u-about:same-site',
      'p-about:fallback',
    ])
    expect(deck[0]).not.toHaveProperty('style')
  })

  it('reads style profiles beside the configured catalog and degrades when they are missing or malformed', () => {
    const root = library()
    const site = (id: string, family: string, name: string) => ({
      ...entry,
      id,
      group: id,
      family,
      source: `https://www.${name}.example/`,
    })
    save(root, [
      site('a-hero', 'hero', 'a'),
      site('a-hero-odd', 'hero', 'a'),
      site('b-about', 'about', 'b'),
      site('c-about', 'about', 'c'),
    ])
    vi.stubEnv('TASTECODE_REFERENCE_LIBRARY', root)
    const profileFile = path.join(root, 'style-profiles.json')
    const shared = { theme: 'dark', headingType: 'serif', bodyType: 'serif' }
    writeFileSync(
      profileFile,
      JSON.stringify({
        version: 1,
        sites: {
          'www.a.example': { ...shared, outliers: ['a-hero-odd'], summary: 'Dark serif.' },
          'c.example': shared,
        },
      }),
    )
    const last = (length: number) => length - 1
    expect(selectReviewedReferences(brief, undefined, last)).toMatchObject([
      { id: 'a-hero', role: 'anchor', site: 'a.example', style: 'Dark serif.' },
      { id: 'c-about', role: 'similar-site', site: 'c.example' },
      { id: 'b-about', role: 'fallback', site: 'b.example' },
    ])
    for (const contents of ['{', '{"version":2,"sites":{}}', '[]']) {
      writeFileSync(profileFile, contents)
      const deck = selectReviewedReferences(brief, undefined, last)
      expect(deck[0]).toMatchObject({ id: 'a-hero-odd', role: 'anchor', site: 'a.example' })
      expect(deck[0]).not.toHaveProperty('style')
      expect(deck.slice(1).map(({ role }) => role)).toEqual(['fallback', 'fallback'])
    }
    rmSync(profileFile)
    expect(selectReviewedReferences(brief, undefined, last)[0]?.id).toBe('a-hero-odd')
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

  it('derives valid generated ids from arbitrary library folder names', () => {
    const root = library()
    const long = 'x'.repeat(120)
    for (const name of ['Acme Studio', 'acme.com', '__lab__', long]) {
      mkdirSync(path.join(root, name, 'generated'), { recursive: true })
      writeFileSync(path.join(root, name, 'README.md'), 'Source: https://example.com/acme\n')
      copyFileSync(
        path.join(root, 'hero.webp'),
        path.join(root, name, 'generated', '01-hero-desktop.webp'),
      )
    }
    save(root, [entry])
    const references = loadReviewedReferences(root)
    expect(references.map(({ id }) => id).sort()).toEqual(
      [
        'acme-com-01-hero',
        'acme-studio-01-hero',
        'lab-01-hero',
        `${long}-01-hero`.slice(0, 96),
        'studio-hero',
      ].sort(),
    )
    expect(references.find(({ id }) => id === 'acme-studio-01-hero')?.imagePath).toBe(
      path.join(root, 'Acme Studio', 'generated', '01-hero-desktop.webp'),
    )
    mkdirSync(path.join(root, 'acme_studio', 'generated'), { recursive: true })
    writeFileSync(path.join(root, 'acme_studio', 'README.md'), 'Source: https://example.com/a\n')
    copyFileSync(
      path.join(root, 'hero.webp'),
      path.join(root, 'acme_studio', 'generated', '01-hero-desktop.webp'),
    )
    expect(() => loadReviewedReferences(root)).toThrow('duplicate reference IDs')
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
        source: 'https://editorial.example/about',
        tags: ['serif'],
      },
    ])
    expect(
      selectReviewedReferences(
        { ...brief, requiredContent: ['Hero', 'About introduction'] },
        loadReviewedReferences(root),
        () => 0,
      ).map(({ family, role }) => `${family}:${role}`),
    ).toEqual(['hero:anchor', 'about:fallback'])
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
  it('round-trips deck sites, roles and the anchor style while old decks still parse', () => {
    const saved = {
      id: 'studio-hero',
      family: 'hero',
      cue: 'Centered portrait collage.',
      imagePath: '/library/hero.webp',
    }
    expect(parseReferenceDeck([saved])).toEqual([saved])
    const deck = [
      { ...saved, site: 'example.com', role: 'anchor', style: 'Quiet serif studio.' },
      { ...saved, id: 'studio-about', family: 'about', site: 'example.com', role: 'same-site' },
      { ...saved, id: 'other-faq', family: 'faq', site: 'other.example', role: 'similar-site' },
      { ...saved, id: 'any-footer', family: 'footer', role: 'fallback' },
    ]
    expect(parseReferenceDeck(JSON.parse(JSON.stringify(deck)))).toEqual(deck)
    expect(() => parseReferenceDeck([{ ...saved, role: 'primary' }])).toThrow('studio-hero.role')
    expect(() => parseReferenceDeck([{ ...saved, site: 7 }])).toThrow('studio-hero.site')

    const root = library()
    save(root, [{ ...entry, site: 'claimed.example', role: 'anchor', style: 'Claimed.' }])
    const [loaded] = loadReviewedReferences(root)
    expect(loaded).not.toHaveProperty('site')
    expect(loaded).not.toHaveProperty('role')
    expect(loaded).not.toHaveProperty('style')
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
