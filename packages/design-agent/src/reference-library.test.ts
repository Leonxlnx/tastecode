import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DesignBrief } from './brief.js'
import {
  loadReviewedReferences,
  parseReferenceDeck,
  selectReviewedReferences,
} from './reference-library.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function library() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'taste-references-'))
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

  it('indexes complete generated candidates without claiming visual approval or resurrecting rejected entries', () => {
    const root = library()
    const site = path.join(root, 'new-studio')
    const generated = path.join(site, 'generated')
    mkdirSync(generated, { recursive: true })
    writeFileSync(
      path.join(site, 'manifest.json'),
      JSON.stringify({
        source: 'https://example.com/new',
        sections: ['hero', { order: 2, label: 'services', status: 'revision-needed' }],
      }),
    )
    for (const name of [
      '01-hero-desktop',
      '01-hero-desktop-full',
      '01-hero-mobile',
      '01-hero-mobile-v2',
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
  it('randomly chooses suitable groups while honoring an explicitly requested reference', () => {
    const root = library()
    save(root, [entry, { ...entry, id: 'second-hero', group: 'second-hero' }])
    const references = loadReviewedReferences(root)
    const first = selectReviewedReferences(brief, references, () => 0)[0]?.id
    const last = selectReviewedReferences(brief, references, (length) => length - 1)[0]?.id
    expect(first).not.toBe(last)
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
