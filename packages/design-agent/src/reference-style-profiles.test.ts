import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_STYLE_SIMILARITY,
  MIN_SIMILAR_STYLE_SCORE,
  REFERENCE_STYLE_PROFILE_FILE,
  isStyleOutlier,
  loadReferenceStyleProfiles,
  referenceSite,
  styleProfileSummary,
  styleSimilarity,
  type ReferenceStyleProfile,
} from './reference-style-profiles.js'

const bundled = fileURLToPath(new URL('../references/library/', import.meta.url))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function root(contents?: string) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'taste-style-profiles-')))
  roots.push(directory)
  if (contents !== undefined)
    writeFileSync(path.join(directory, REFERENCE_STYLE_PROFILE_FILE), contents)
  return directory
}
function profile(overrides: Partial<ReferenceStyleProfile> = {}): ReferenceStyleProfile {
  return { mood: [], outliers: new Set(), ...overrides }
}

describe('reference style profiles', () => {
  it('profiles the bundled source sites and keeps outliers on their own site', () => {
    const profiles = loadReferenceStyleProfiles(bundled)
    expect(profiles.size).toBe(53)
    const catalog = JSON.parse(readFileSync(path.join(bundled, 'catalog.json'), 'utf8')) as {
      references: { id: string; source: string }[]
    }
    const hosts = new Set(catalog.references.map(({ source }) => referenceSite(source)!))
    expect([...hosts].filter((host) => !profiles.has(host))).toEqual([
      'maestroclass.framer.website',
    ])
    for (const [site, entry] of profiles) {
      expect(entry.summary, site).toBeTruthy()
      for (const outlier of entry.outliers) {
        const reference = catalog.references.find(({ id }) => id === outlier)
        if (reference) expect(referenceSite(reference.source)).toBe(site)
      }
    }
    expect(
      isStyleOutlier(profiles.get('stodio.webflow.io'), { id: 'stodio-11-cta', group: 'x' }),
    ).toBe(true)
    expect(isStyleOutlier(profiles.get('stodio.webflow.io'), { id: 'stodio-01-hero' })).toBe(false)
    expect(isStyleOutlier(undefined, { id: 'stodio-11-cta' })).toBe(false)
  })

  it('degrades a missing, malformed or wrong-version file to no profiles', () => {
    expect(loadReferenceStyleProfiles(root()).size).toBe(0)
    expect(loadReferenceStyleProfiles(root('{')).size).toBe(0)
    expect(loadReferenceStyleProfiles(root('[]')).size).toBe(0)
    expect(loadReferenceStyleProfiles(root('{"version":2,"sites":{"a.com":{}}}')).size).toBe(0)
    expect(loadReferenceStyleProfiles(root('{"version":1,"sites":[]}')).size).toBe(0)
    expect(loadReferenceStyleProfiles(path.join(root(), 'missing-directory')).size).toBe(0)
  })

  it('skips malformed sites, ignores malformed fields and keys sites without www', () => {
    const profiles = loadReferenceStyleProfiles(
      root(
        JSON.stringify({
          version: 1,
          sites: {
            'WWW.Studio.example': {
              theme: 'light',
              headingType: 7,
              mood: ['Calm', 3, ''],
              outliers: ['studio-cta', null],
              summary: '  Quiet serif studio.  ',
            },
            'broken.example': 'not a profile',
            'list.example': ['not', 'a', 'profile'],
          },
        }),
      ),
    )
    expect([...profiles.keys()]).toEqual(['studio.example'])
    const studio = profiles.get('studio.example')!
    expect(studio).toMatchObject({ theme: 'light', mood: ['calm'], summary: 'Quiet serif studio.' })
    expect(studio.headingType).toBeUndefined()
    expect([...studio.outliers]).toEqual(['studio-cta'])
  })

  it('derives the site key from a source URL host', () => {
    expect(referenceSite('https://www.Example.com/about?x=1')).toBe('example.com')
    expect(referenceSite('https://studio.framer.website/')).toBe('studio.framer.website')
    expect(referenceSite('not a url')).toBeUndefined()
    expect(referenceSite(undefined)).toBeUndefined()
  })

  it('scores type families, theme, radius, density, imagery and mood deterministically', () => {
    const anchor = profile({
      theme: 'light',
      headingType: 'serif',
      bodyType: 'grotesk-sans',
      radius: 'small',
      density: 'airy',
      imagery: 'photographic',
      mood: ['calm', 'editorial', 'warm', 'premium'],
    })
    expect(styleSimilarity(anchor, anchor)).toBe(3 + 2 + 2 + 2 + 1 + 1 + 3)
    expect(styleSimilarity(anchor, anchor)).toBe(MAX_STYLE_SIMILARITY)
    // The similar-site minimum stays above half the scale, so related is not enough.
    expect(MIN_SIMILAR_STYLE_SCORE).toBeGreaterThan(MAX_STYLE_SIMILARITY / 2)
    expect(
      styleSimilarity(
        anchor,
        profile({ headingType: 'high-contrast-serif', bodyType: 'geometric-sans' }),
      ),
    ).toBe(2 + 1)
    expect(styleSimilarity(anchor, profile({ headingType: 'grotesk-sans' }))).toBe(0)
    expect(
      styleSimilarity(profile({ headingType: 'mono' }), profile({ headingType: 'mono' })),
    ).toBe(3)
    expect(styleSimilarity(anchor, profile({ theme: 'mixed', radius: 'medium' }))).toBe(1 + 1)
    expect(styleSimilarity(anchor, profile({ theme: 'dark', radius: 'large' }))).toBe(0)
    expect(styleSimilarity(profile({ radius: 'mixed' }), profile({ radius: 'sharp' }))).toBe(0)
    expect(styleSimilarity(anchor, profile({ mood: ['calm', 'bold'] }))).toBe(1)
  })

  it('summarizes the anchor design language on one bounded line', () => {
    expect(
      styleProfileSummary(
        profile({ summary: 'Warm editorial\nserif look.', typefaceGuess: 'Fraunces + Inter.' }),
      ),
    ).toBe('Warm editorial serif look. Typefaces: Fraunces + Inter.')
    expect(styleProfileSummary(profile())).toBeUndefined()
    expect(styleProfileSummary(undefined)).toBeUndefined()
    expect(styleProfileSummary(profile({ summary: 'x'.repeat(2000) }))).toHaveLength(700)
  })
})
