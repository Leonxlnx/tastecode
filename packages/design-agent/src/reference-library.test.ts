import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('selects relevant compositions, deduplicates revisions, and discovers later additions', () => {
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
    expect(() => selectReviewedReferences(brief, [])).toThrow('No reviewed')
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
    expect(() => loadReviewedReferences(root)).toThrow('no visually reviewed references')
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
