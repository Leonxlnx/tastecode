import { describe, expect, it } from 'vitest'
import { parseAppDirection, selectAppDirection } from './app-screens.js'
import type { AssetManifest } from './assets.js'
import { designBrandPrompt, parseBrandPhaseOutput } from './brand-phase.js'
import type { DesignBrief } from './brief.js'
import { designBuildPrompt } from './build-phase.js'
import { designConsistencyFindings, type DesignConsistencyAudit } from './design-consistency.js'
import type { PageBlueprint } from './page.js'
import { designPagePrompt, parsePagePhaseOutput } from './page-phase.js'
import { designRepairPrompt, designReviewPrompt } from './review-phase.js'
import { selectTypographyCandidates, validateTypographySelection } from './typography.js'

const brief: DesignBrief = {
  originalRequest: 'Build the deploy overview for our API platform',
  subject: 'Relayfly hosting',
  pageType: 'dashboard',
  scope: 'Overview screen',
  primaryGoal: 'See which deploy broke',
  audience: 'Developers on call',
  offer: 'Hosting',
  primaryAction: 'Redeploy',
  requiredContent: ['Current deploy', 'Error rate', 'Deployments table'],
  constraints: [],
  brandInputs: [],
  creativeControl: 'Agent decides',
  explicitAnswers: [],
  assumptions: [],
  unresolved: [],
}
// The style tasteskill prefers first for developer platforms, whatever the draw.
const direction = parseAppDirection({
  ...selectAppDirection(brief, () => 0),
  style: 'framed-sheet',
  shell: 'framed-sheet',
})

const brand = parseBrandPhaseOutput(
  JSON.stringify({
    version: 1,
    foundation: {
      strategy: 'create',
      existingAssets: [],
      assetActions: [],
      lockedDecisions: [],
      assumptions: [],
    },
    creativeDirection: {
      summary: 'Framed sheet with the deploy commit as the hero.',
      traits: [{ quality: 'Exact', boundary: 'not cold' }],
      productiveTension: 'Dense yet calm',
      signatureDevice: { description: 'Deploy markers', status: 'candidate', invariants: [] },
      restraint: 'Colour on data only',
      avoid: [],
    },
    colorPalette: [
      { name: 'ground', value: '#f6f6f6', usage: 'Frame' },
      { name: 'chart-1', value: '#1b6c80', usage: 'Main series' },
    ],
    typefaces: [
      { family: 'IBM Plex Sans', source: 'Google Fonts', roles: ['interface'], weights: [400] },
    ],
    interfaceDirection: 'Tinted frame, white sheet.',
    imageDirection: { summary: 'None.', subjects: [], treatment: 'None.', avoid: [] },
    motionDirection: { summary: 'Feedback.', principles: [], avoid: [] },
    voice: { summary: 'Plain.', avoid: [] },
  }),
)

const page = {
  version: 1,
  page: { title: 'Relayfly', route: '/', description: 'Deploy overview' },
  architecture: {
    contract: 'This screen answers which deploy broke.',
    mode: 'operate_monitor',
    novelty: 'low',
    grid: '12 x 77 + 11 x 16 = 1100',
    signatureRule: 'One tinted L-frame.',
    rhythm: '44px rows',
  },
  navigation: [{ label: 'Deployments', target: '#/deployments' }],
  sections: [
    {
      id: 'live_deploy',
      layoutFamily: 'dashboard',
      layoutCases: ['deploy-health-lead'],
      purpose: 'Show what is live',
      userQuestion: 'Which deploy broke?',
      copy: {
        heading: 'Production',
        body: ['Sample data', 'Error rate 0.28% after deploy a3f09c1'],
        callsToAction: [{ label: 'Redeploy', target: '#redeploy' }],
      },
      layout: 'Full-width card',
      componentNeeds: [],
      assetNeeds: [],
      transformation: { compact: 'Stack', medium: 'Two columns', expanded: 'Full width' },
    },
  ],
  responsive: [],
  interactions: [],
  acceptanceCriteria: [],
}

describe('app-screen phases', () => {
  it('deals a devtools sheet for this brief', () => {
    expect(direction).toMatchObject({ kind: 'devtools', style: 'framed-sheet' })
    expect(direction.screens[0]).toEqual({ name: 'overview', pattern: 'platform-overview-tray' })
  })

  it('briefs Brand with the sheet and named colours instead of anchor references', () => {
    const prompt = designBrandPrompt(
      brief,
      [],
      selectTypographyCandidates(() => 0),
      direction,
    )
    expect(prompt).toContain('Brand phase of TasteCode Design Mode for an app screen')
    expect(prompt).toContain('1. The style: Framed sheet (framed-sheet, light)')
    expect(prompt).toContain('Return colorPalette, not paletteRecipe')
    expect(prompt).toContain('APP TYPE')
    expect(prompt).toContain('Use "IBM Plex Sans" for the whole interface')
    expect(prompt).toContain('### 9.1 Type')
    expect(prompt).not.toContain('TYPOGRAPHY DRAW')
    expect(prompt).not.toContain('anchor reference')
  })

  it('accepts only the sheet faces or an explicit request on an app screen', () => {
    const candidates = selectTypographyCandidates(() => 0)
    expect(() => validateTypographySelection(brief, brand, candidates, direction)).not.toThrow()
    const drawn = {
      ...brand,
      typefaces: [{ ...brand.typefaces[0]!, family: candidates.sans[0]! }],
    }
    expect(() => validateTypographySelection(brief, drawn, candidates, direction)).toThrow(
      "Use the app sheet's typeface (IBM Plex Sans or IBM Plex Mono)",
    )
    expect(() => validateTypographySelection(brief, drawn, candidates)).not.toThrow()
  })

  it('plans one operating screen from the sheet and locks it as a dashboard', () => {
    const prompt = designPagePrompt(brief, brand, [], [], direction)
    expect(prompt).toContain('Page Blueprint phase of TasteCode Design Mode for an app screen')
    expect(prompt).toContain('### 2.2 Name the screen')
    expect(prompt).toContain('## 12. The phone')
    expect(prompt).toContain('"layoutFamily":"dashboard"')
    expect(prompt).not.toContain('REFERENCE LOCK')

    const parsed = parsePagePhaseOutput(JSON.stringify(page), [], [], true, direction)
    expect(parsed.sections[0]).toMatchObject({ layoutFamily: 'dashboard' })
    expect(parsed.sections[0]?.referenceDirectionId).toBeUndefined()
    expect(() =>
      parsePagePhaseOutput(
        JSON.stringify({ ...page, architecture: { ...page.architecture, mode: 'scan_compare' } }),
        [],
        [],
        true,
        direction,
      ),
    ).toThrow('operate_monitor')
    expect(() =>
      parsePagePhaseOutput(
        JSON.stringify({ ...page, sections: [{ ...page.sections[0], layoutFamily: 'hero' }] }),
        [],
        [],
        true,
        direction,
      ),
    ).toThrow('must be dashboard on an app screen')
    const withMockup = { ...page, sections: [{ ...page.sections[0], referenceDirectionId: 'x' }] }
    expect(() =>
      parsePagePhaseOutput(JSON.stringify(withMockup), [], ['user-reference-1'], true, direction),
    ).toThrow('may only name an attached user reference')
    expect(() =>
      parsePagePhaseOutput(JSON.stringify(page), [], ['user-reference-1'], true, direction),
    ).toThrow('at least one attached user reference')
  })

  it('builds from the kit with the audit constraints spelled out', () => {
    const assets: AssetManifest = { version: 1, assets: [] }
    const prompt = designBuildPrompt(brief, brand, page as PageBlueprint, assets, [], direction)
    expect(prompt).toContain('Build phase of TasteCode Design Mode for an app screen')
    expect(prompt).toContain("TasteCode placed tasteskill's kit in .taste/app-kit/")
    expect(prompt).toContain('exactly one h1')
    expect(prompt).toContain('44 by 44 CSS pixels')
    expect(prompt).toContain('"IBM Plex Sans"')
    expect(prompt).toContain('## 14. Tells of generated dashboards')
    expect(prompt).toContain('Verify before publishing:')
    expect(prompt).not.toContain('<reference-reveal-source>')
    expect(prompt).not.toContain('referenceDirectionId, layoutFamily, one or more')
  })

  it('reviews and repairs against the critique, house rules and tells', () => {
    const screenshots = [
      { path: '/tmp/1440x1000.png', width: 1440, height: 1000 },
      { path: '/tmp/390x844.png', width: 390, height: 844 },
    ]
    const review = designReviewPrompt(
      brief,
      brand,
      page as PageBlueprint,
      screenshots,
      [],
      [],
      undefined,
      direction,
    )
    expect(review).toContain('visual Review phase of TasteCode Design Mode for an app screen')
    expect(review).toContain('### 2.7 The check')
    expect(review).toContain('## 13. House rules for app screens')
    expect(review).not.toContain('<internal-reference-directions>')

    const repair = designRepairPrompt(
      {
        version: 1,
        verdict: 'repair',
        summary: 'One row is ragged.',
        findings: [
          {
            id: 'ragged_row',
            severity: 'major',
            area: 'Overview',
            evidenceType: 'visual_inspection',
            confidence: 'high',
            evidence: 'Cards end 40px apart.',
            repair: 'Balance the row.',
          },
        ],
      },
      1,
      2,
      brief,
      brand,
      page as PageBlueprint,
      { version: 1, assets: [] },
      [],
      screenshots,
      direction,
    )
    expect(repair).toContain('the dealt app sheet remain immutable during repair')
    expect(repair).toContain('## 13. House rules for app screens')
    expect(repair).not.toContain('referenceDirectionId and artifacts remain immutable')
  })

  it('leaves radius drift out of the source audit on an app screen', () => {
    const audit: DesignConsistencyAudit = {
      approvedFonts: ['IBM Plex Sans'],
      fonts: [{ family: 'Inter', files: ['app.css'] }],
      radii: [{ value: '2px', files: ['charts.js'] }],
      radiusTokens: ['6px', '8px'],
      radiiOutsideTokens: ['2px'],
    }
    expect(designConsistencyFindings(audit).map(({ id }) => id)).toEqual([
      'font_family_drift',
      'radius_scale_drift',
    ])
    expect(designConsistencyFindings(audit, { radii: false }).map(({ id }) => id)).toEqual([
      'font_family_drift',
    ])
  })
})
