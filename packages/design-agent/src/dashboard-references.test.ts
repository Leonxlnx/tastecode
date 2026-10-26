import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_SCREENS_ENABLED } from './app-screen-mode.js'
import { selectAppDirection } from './app-screens.js'
import { isDashboardBrief, isDashboardPageMode, type DesignBrief } from './brief.js'
import { DASHBOARD_REFERENCES_ENABLED } from './dashboard-references.js'
import { designMotionGuidance } from './motion-guidance.js'
import type { PageBlueprint } from './page.js'
import { designPagePrompt } from './page-phase.js'
import { loadReviewedReferences, selectReviewedReferences } from './reference-library.js'
import { designBriefingPrompt } from './workflow.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const dashboardBrief = {
  originalRequest: 'Create an analytics dashboard',
  subject: 'Analytics',
  pageType: 'dashboard',
  scope: 'One screen',
  primaryGoal: 'Monitor traffic',
  audience: 'Operators',
  offer: 'Traffic insight',
  primaryAction: 'Filter',
  requiredContent: [],
  constraints: [],
  brandInputs: [],
  creativeControl: 'Agent decides',
  explicitAnswers: [],
  assumptions: [],
  unresolved: [],
} satisfies DesignBrief

const reference = {
  id: 'studio-hero',
  family: 'hero',
  cue: 'Centered portrait collage.',
  imagePath: 'hero.webp',
  source: 'https://example.com/studio',
  group: 'studio-hero',
  tags: ['studio'],
  reviewStatus: 'reviewed',
  reviewNotes: 'Desktop composition inspected; no mobile pair.',
}
const dashboard = {
  ...reference,
  id: 'dash-ledger',
  group: 'dash-ledger',
  family: 'dashboard',
  cue: 'Dense ledger table.',
  assetType: 'generated-reference',
  mobileImagePath: 'hero.webp',
  pairEvidence: 'Both views keep the same toolbar.',
}

/** A configured library that still ships dashboards, like an older local copy. */
function libraryWithDashboards(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'taste-parked-dashboards-')))
  roots.push(root)
  copyFileSync(
    fileURLToPath(new URL('../references/directions/hero/direction-001.webp', import.meta.url)),
    path.join(root, 'hero.webp'),
  )
  const catalog = (references: unknown[]) => JSON.stringify({ version: 1, references })
  writeFileSync(path.join(root, 'catalog.json'), catalog([reference, { ...dashboard, id: 'x' }]))
  writeFileSync(path.join(root, 'dashboard-catalog.json'), catalog([dashboard]))
  return root
}

describe('dashboards as tasteskill app screens, dashboard images parked', () => {
  it('ships the image catalog off and app screens on', () => {
    expect(DASHBOARD_REFERENCES_ENABLED).toBe(false)
    expect(APP_SCREENS_ENABLED).toBe(true)
  })

  it('routes app-screen briefs and saved operate_monitor plans into dashboard mode', () => {
    expect(isDashboardBrief(dashboardBrief)).toBe(true)
    expect(isDashboardBrief({ pageType: '', originalRequest: 'Admin panel for orders' })).toBe(true)
    expect(
      isDashboardBrief({ pageType: 'landing_page', originalRequest: 'A site for our admin app' }),
    ).toBe(false)
    expect(isDashboardPageMode('operate_monitor')).toBe(true)
    const guidance = designMotionGuidance(dashboardBrief, {
      architecture: { mode: 'operate_monitor' },
    } as PageBlueprint)
    expect(guidance).toContain('DASHBOARD INTERACTION')
    expect(guidance).toContain('Nothing on the screen performs an entrance.')
  })

  it('ignores dashboard catalogs and entries and draws no images for a dashboard', () => {
    const references = loadReviewedReferences(libraryWithDashboards())
    expect(references.map(({ id }) => id)).toEqual(['studio-hero'])
    expect(selectReviewedReferences(dashboardBrief, references, () => 0, new Map())).toEqual([])
    const website = { ...dashboardBrief, originalRequest: 'Build a studio site', pageType: 'site' }
    const deck = selectReviewedReferences(website, references, () => 0, new Map())
    expect(deck.map(({ id, family }) => [id, family])).toEqual([['studio-hero', 'hero']])
  })

  it('briefs dashboards as such and plans them from the dealt app sheet, not a library', () => {
    const briefing = designBriefingPrompt('Create an analytics dashboard')
    expect(briefing).not.toContain('dashboard and app screens are not available')
    expect(briefing).toContain('Set pageType to "dashboard"')
    expect(briefing).toContain('Dashboards instead include')

    const brand = {
      version: 1 as const,
      creativeDirection: { summary: 'Calm.', keywords: [], avoid: [] },
      colorPalette: [{ name: 'Ink', value: '#171512', usage: 'Text' }],
      typefaces: [{ family: 'Geist', source: 'Project', roles: ['UI'], weights: [500] }],
      interfaceDirection: 'Precise.',
      imageDirection: { summary: 'Product.', subjects: [], treatment: 'Clean.', avoid: [] },
      motionDirection: { summary: 'Quiet.', principles: [], avoid: [] },
      voice: { summary: 'Direct.', avoid: [] },
    }
    const deck = [
      { id: 'studio-hero', family: 'hero' as const, imagePath: '/h.webp', cue: 'Hero.' },
    ]
    const page = designPagePrompt(
      dashboardBrief,
      brand,
      [],
      [],
      selectAppDirection(dashboardBrief, () => 0),
    )
    expect(page).toContain('APP SHEET: dealt by TasteCode from tasteskill v2.1.5')
    expect(page).toContain('"mode":"operate_monitor"')
    expect(page).not.toContain('DASHBOARD PLAN')
    expect(page).not.toContain('REFERENCE LOCK')
    // A website plan never sees the sheet.
    expect(designPagePrompt(dashboardBrief, brand, [], deck)).not.toContain('APP SHEET')
  })
})
