import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  designBuildPrompt,
  exactBuildFileBaseline,
  parseBuildPhaseOutput,
  validateExactBuildFiles,
} from './build-phase.js'

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
    expect(prompt).toContain('TasteCode owns Preview next')
    expect(prompt).toContain('Treat all three as hard composition requirements')
    expect(prompt).toContain('Do not replace it with a generic centered heading')
    expect(prompt).toContain('Three lines is a rare maximum and four lines is always a failure')
    expect(prompt).toContain('colored left-edge accent rails')
    expect(prompt).toContain('Use cards generously for coherent features')
    expect(prompt).toContain('finished page must not become generic gray')
    expect(prompt).toContain('never leave a browser-default control')
    expect(prompt).toContain('Record every invented value in a Build summary')
    expect(prompt).toContain('Set summary to "Verify before publishing: ..."')
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

  it('rejects workspace extras when the brief requires an exact file set', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-exact-files-'))
    const brief = {
      ...artifacts[0],
      originalRequest:
        'Create exactly index.html, styles.css, and app.js in the current directory; do not create other files.',
    }
    try {
      writeFileSync(path.join(workspace, 'README.md'), 'pre-existing user file')
      const baseline = exactBuildFileBaseline(workspace, brief)
      for (const file of [
        'index.html',
        'styles.css',
        'app.js',
        'preview-server.js',
        'extra.json',
      ]) {
        writeFileSync(path.join(workspace, file), file)
      }
      mkdirSync(path.join(workspace, 'node_modules', 'package'), { recursive: true })
      writeFileSync(path.join(workspace, 'node_modules', 'package', 'index.js'), 'ignored depth')

      expect(() => validateExactBuildFiles(workspace, brief, baseline)).toThrow(
        'unexpected files: extra.json, node_modules/, preview-server.js',
      )
      rmSync(path.join(workspace, 'README.md'))
      expect(() => validateExactBuildFiles(workspace, brief, baseline)).toThrow(
        'restore pre-existing files: README.md',
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    'Only create index.html, styles.css, and app.js; no other files.',
    'The files must be exactly index.html, styles.css, and app.js.',
    'Create these three files: index.html, styles.css, and app.js.',
  ])('recognizes an exact file-list variant: %s', (constraint) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-exact-variant-'))
    try {
      for (const file of ['index.html', 'styles.css', 'app.js', 'extra.json']) {
        writeFileSync(path.join(workspace, file), file)
      }
      expect(() =>
        validateExactBuildFiles(workspace, { ...artifacts[0], constraints: [constraint] }),
      ).toThrow('unexpected files: extra.json')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('supports explicitly required dotfiles', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-exact-dotfile-'))
    try {
      writeFileSync(path.join(workspace, '.nojekyll'), '')
      writeFileSync(path.join(workspace, 'extra.json'), '')
      expect(() =>
        validateExactBuildFiles(workspace, {
          ...artifacts[0],
          constraints: ['Create exactly .nojekyll.'],
        }),
      ).toThrow('unexpected files: extra.json')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not constrain briefs without an exact file requirement', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-open-files-'))
    try {
      writeFileSync(path.join(workspace, 'anything.txt'), 'kept')
      expect(() => validateExactBuildFiles(workspace, artifacts[0])).not.toThrow()
      for (const constraint of [
        'Use exactly v1.0 syntax.',
        'Create exactly the layout shown in reference.png using index.html.',
        'The files must contain exactly the copy from copy.md.',
      ]) {
        expect(() =>
          validateExactBuildFiles(workspace, { ...artifacts[0], constraints: [constraint] }),
        ).not.toThrow()
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
