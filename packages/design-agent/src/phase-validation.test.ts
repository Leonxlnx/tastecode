import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrandSystem } from './brand.js'
import type { DesignBrief } from './brief.js'
import { validateExactBuildFiles } from './build-phase.js'
import { assertPageCopy } from './copywriting.js'
import type { PageBlueprint } from './page.js'
import { parsePreviewPhaseOutput } from './preview.js'
import { enforceDomAuditFindings, validateReviewScreenshots } from './review-phase.js'
import { selectTypographyCandidates, validateTypographySelection } from './typography.js'
import { parseBriefingOutput } from './workflow.js'

const brief: DesignBrief = {
  originalRequest: 'Design a page',
  subject: 'Coffee',
  pageType: 'Landing page',
  scope: 'One page',
  primaryGoal: 'Sell coffee',
  audience: 'Home brewers',
  offer: 'Fresh coffee',
  primaryAction: 'Buy coffee',
  requiredContent: [],
  constraints: [],
  brandInputs: [],
  creativeControl: 'Agent decides',
  explicitAnswers: [],
  assumptions: [],
  unresolved: [],
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('exact deliverable extraction', () => {
  it.each([
    'Create exactly index.html. Use photos from unsplash.com.',
    'Create exactly index.html using photos from unsplash.photography.',
    'Create exactly index.html and use https://example.com/photo.jpg.',
    'Create exactly index.html, https://example.com/photo.jpg.',
    'Create exactly index.html; use www.example.com.',
    'Create exactly index.html and photos from cdn.example.org.',
  ])('does not turn domains or URLs into deliverables: %s', (originalRequest) => {
    const root = mkdtempSync(path.join(tmpdir(), 'taste-exact-files-'))
    roots.push(root)
    writeFileSync(path.join(root, 'index.html'), '<main>Coffee</main>')
    expect(() => validateExactBuildFiles(root, { ...brief, originalRequest })).not.toThrow()
    writeFileSync(path.join(root, 'extra.js'), '')
    expect(() => validateExactBuildFiles(root, { ...brief, originalRequest })).toThrow(
      'unexpected files: extra.js',
    )
  })
})

describe('finished interface copy', () => {
  function copy(description: string): PageBlueprint {
    return {
      version: 1,
      page: { title: 'Northstar', route: '/', description },
      navigation: [],
      sections: [],
      responsive: [],
      interactions: [],
      acceptanceCriteria: [],
    } as unknown as PageBlueprint
  }
  it.each([
    'Not connected',
    'Test data',
    'Local preview',
    'Awaiting approval',
    'Nothing leaves this page',
    'This prototype explores scheduling',
    'Review permissions before launch',
    'Simulated data',
    'Connect a live sensor',
  ])('preserves legitimate interface copy: %s', (description) => {
    expect(() => assertPageCopy(copy(description))).not.toThrow()
  })
  it.each([
    'Lorem ipsum dolor sit amet',
    'TODO: add product description',
    'Your text here',
    'Insert headline here',
    '[placeholder image]',
    'Sample data. To be supplied.',
  ])('still rejects unfinished copy: %s', (description) => {
    expect(() => assertPageCopy(copy(description))).toThrow('copy/internal-placeholder')
  })
})

describe('explicit font choices', () => {
  const brand = {
    foundation: { strategy: 'create' },
    typefaces: [{ family: 'Inter' }],
  } as unknown as BrandSystem
  const candidates = selectTypographyCandidates(() => 0)
  it.each([
    'Build an interface',
    'An interactive page with custom fonts',
    'An international brand',
    'A page about Inter Milan',
    'Prefer interesting typography',
  ])('does not mistake prose for the Inter font: %s', (originalRequest) => {
    expect(() =>
      validateTypographySelection({ ...brief, originalRequest }, brand, candidates),
    ).toThrow('first-draw')
  })
  it.each([
    'Use Inter',
    'Use the Inter font',
    'The typeface should be Inter.',
    'Set headings in Inter.',
    'Typography: Inter',
  ])('honors explicit font context: %s', (originalRequest) => {
    expect(() =>
      validateTypographySelection({ ...brief, originalRequest }, brand, candidates),
    ).not.toThrow()
  })
})

describe('review screenshot coverage', () => {
  const screenshots = [
    { path: 'desktop.png', width: 1440, height: 1000 },
    { path: 'mobile.png', width: 390, height: 844 },
  ]
  const pass = { version: 1 as const, verdict: 'pass' as const, summary: 'Ready', findings: [] }
  it('rejects a passing review with absent desktop or mobile evidence', () => {
    for (const captures of [[], [screenshots[0]!], [screenshots[1]!]]) {
      expect(() => enforceDomAuditFindings(pass, captures)).toThrow('requires both')
    }
    expect(enforceDomAuditFindings(pass, screenshots)).toEqual(pass)
  })
  it('requires every planned viewport, including additional tablet captures', () => {
    const planned = [...screenshots, { width: 768, height: 1024 }]
    expect(() => validateReviewScreenshots(screenshots, planned)).toThrow('768x1024')
    expect(() =>
      validateReviewScreenshots(
        [...screenshots, { path: 'tablet.png', width: 768, height: 1024 }],
        planned,
      ),
    ).not.toThrow()
  })
  it('requires desktop and mobile in newly proposed preview plans', () => {
    const plan = {
      version: 1,
      kind: 'static',
      entry: 'index.html',
      cwd: '.',
      url: 'http://127.0.0.1:4173/',
      viewports: screenshots.map(({ width, height }, index) => ({
        name: String(index),
        width,
        height,
      })),
    }
    expect(() => parsePreviewPhaseOutput(JSON.stringify(plan))).not.toThrow()
    expect(() =>
      parsePreviewPhaseOutput(JSON.stringify({ ...plan, viewports: plan.viewports.slice(0, 1) })),
    ).toThrow('requires both')
  })
})

describe('complete briefing validation', () => {
  it('rejects malformed complete briefs before a caller can reset its correction state', () => {
    for (const invalid of [{}, { ...brief, subject: '' }, { ...brief, requiredContent: 'Hero' }]) {
      expect(() =>
        parseBriefingOutput(
          JSON.stringify({ status: 'complete', message: 'Done', brief: invalid }),
        ),
      ).toThrow('design brief field')
    }
    expect(
      parseBriefingOutput(JSON.stringify({ status: 'complete', message: 'Done', brief })),
    ).toMatchObject({ status: 'complete', brief })
  })
})
