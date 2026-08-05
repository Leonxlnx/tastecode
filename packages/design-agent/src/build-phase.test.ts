import { describe, expect, it } from 'vitest'
import { designBuildPrompt, parseBuildPhaseOutput } from './build-phase.js'

const artifacts = [
  {
    originalRequest: 'Build a page.',
    subject: 'Coffee',
    pageType: 'Landing page',
    scope: 'One page',
    primaryGoal: 'Sell coffee',
    audience: 'Home brewers',
    offer: 'Fresh coffee',
    primaryAction: 'Buy',
    requiredContent: [],
    constraints: [],
    brandInputs: [],
    creativeControl: 'Agent decides',
    explicitAnswers: [],
    assumptions: [],
    unresolved: [],
  },
  {
    version: 1 as const,
    creativeDirection: { summary: 'Warm.', keywords: [], avoid: [] },
    colorPalette: [{ name: 'Ink', value: '#111', usage: 'Text' }],
    typefaces: [{ family: 'Geist', source: 'Project', roles: ['UI'], weights: [500] }],
    interfaceDirection: 'Editorial.',
    imageDirection: { summary: 'Product.', subjects: [], treatment: 'Warm.', avoid: [] },
    motionDirection: { summary: 'Tactile.', principles: [], avoid: [] },
    voice: { summary: 'Direct.', avoid: [] },
  },
  {
    version: 1 as const,
    page: { title: 'Coffee', route: '/', description: 'Fresh coffee.' },
    navigation: [],
    sections: [
      {
        id: 'hero',
        purpose: 'Lead.',
        copy: { heading: 'Fresh.', body: [], callsToAction: [] },
        layout: 'Split.',
        componentNeeds: [],
        assetNeeds: [],
      },
    ],
    responsive: [],
    interactions: [],
    acceptanceCriteria: [],
  },
  { version: 1 as const, assets: [] },
] as const

describe('build phase', () => {
  it('requires the existing architecture and leaves preview to the harness', () => {
    const prompt = designBuildPrompt(...artifacts)
    expect(prompt).toContain('Do not scaffold a second app')
    expect(prompt).toContain('Personal Harness owns Preview next')
  })

  it('parses a completed implementation report', () => {
    expect(
      parseBuildPhaseOutput(
        JSON.stringify({
          status: 'complete',
          summary: 'Implemented the landing page.',
          files: ['src/App.tsx'],
          checks: ['pnpm build — passed'],
        }),
      ),
    ).toMatchObject({ status: 'complete', files: ['src/App.tsx'] })
  })
})
