import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DesignSourceQualityError,
  designBuildPrompt,
  designSourceQualityBaseline,
  designSourceQualityCorrectionPrompt,
  exactBuildFileBaseline,
  parseBuildPhaseOutput,
  validateDesignSourceQuality,
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
    expect(prompt).toContain('The reference is the primary hard composition requirement')
    expect(prompt).toContain("Implement each section's recorded motion decision")
    expect(prompt).toContain('never use transition: all')
    expect(prompt).toContain('replace the reference with a generic centered heading')
    expect(prompt).toContain('with three as the maximum')
    expect(prompt).toContain('full-height one-sided line attached to or aligned with a card edge')
    expect(prompt).toContain('open columns remain open')
    expect(prompt).toContain('finished page must not become generic gray')
    expect(prompt).toContain('never leave a browser-default control')
    expect(prompt).toContain('at least 44 by 44 CSS pixels')
    expect(prompt).toContain('A successful production build with a blank runtime is a failed Build')
    expect(prompt).toContain('Record every invented value in a Build summary')
    expect(prompt).toContain('Never stretch images')
    expect(prompt).toContain('Preserve intentional large media, asymmetry')
    expect(prompt).toContain('<brand-gradient-recipes>')
    expect(prompt).toContain("recipe's opaque contentSurface")
    expect(prompt).toContain('Set summary to "Verify before publishing: ..."')
    expect(prompt).toContain('It may not replace photography, product imagery')
    expect(prompt).toContain('SVG is limited to an explicit functional icon, logo')
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

  it('rejects generated one-sided card rails before Preview', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-source-quality-'))
    try {
      writeFileSync(
        path.join(workspace, 'styles.css'),
        '.feature-card { border-left: 3px solid #f40; padding: 1rem; }',
      )
      expect(() => validateDesignSourceQuality(workspace, [])).toThrow(DesignSourceQualityError)
      expect(() => validateDesignSourceQuality(workspace, ['styles.css'])).toThrow(
        'remove newly introduced card rails or unmanifested SVG substitutes',
      )

      writeFileSync(
        path.join(workspace, 'styles.css'),
        '.feature-card { background: linear-gradient(90deg, #f40 0 4px, transparent 4px); }',
      )
      expect(() => validateDesignSourceQuality(workspace, [])).toThrow(
        'narrow card-edge gradient rail',
      )

      writeFileSync(
        path.join(workspace, 'styles.css'),
        '.feature-card > .accent { inline-size: 3px; align-self: stretch; }',
      )
      expect(() => validateDesignSourceQuality(workspace, [])).toThrow(
        'full-height narrow card-edge strip',
      )

      writeFileSync(
        path.join(workspace, 'Card.tsx'),
        'const FeatureCard = styled.div`border-left: 3px solid #f40; padding: 1rem;`',
      )
      writeFileSync(path.join(workspace, 'styles.css'), '.feature-card { padding: 1rem; }')
      expect(() => validateDesignSourceQuality(workspace, [])).toThrow(
        'uses a one-sided card-edge border',
      )

      writeFileSync(
        path.join(workspace, 'Card.tsx'),
        '<article className="feature-card"><span className="absolute inset-y-0 left-0 w-[3px]" /></article>',
      )
      writeFileSync(path.join(workspace, 'styles.css'), '.feature-card { padding: 1rem; }')
      expect(() => validateDesignSourceQuality(workspace, [])).toThrow(
        'card markup contains a full-height narrow edge strip',
      )

      writeFileSync(
        path.join(workspace, 'styles.css'),
        '.feature-card { border: 1px solid #ddd; padding: 1rem; background: linear-gradient(to right, #fff 0%, #eee 100%); } .feature-card-atmosphere { background: linear-gradient(135deg, #fff, #eee); } .feature-card .divider { width: 40px; height: 2px; }',
      )
      rmSync(path.join(workspace, 'Card.tsx'))
      mkdirSync(path.join(workspace, 'node_modules'), { recursive: true })
      writeFileSync(
        path.join(workspace, 'node_modules', 'vendor.css'),
        '.feature-card { border-left: 3px solid red; }',
      )
      expect(() => validateDesignSourceQuality(workspace, [])).not.toThrow()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('allows a source-quality correction to edit the offending implementation', () => {
    const prompt = designSourceQualityCorrectionPrompt('src/Card.css contains a rail')
    expect(prompt).toContain('Make one bounded edit pass')
    expect(prompt).toContain('Remove every newly introduced prohibited source pattern')
    expect(prompt).toContain('raw or standalone SVG substitutes')
    expect(prompt).not.toContain('Do not repeat tool work')
  })

  it('rejects only source-quality violations introduced after the Build baseline', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-source-baseline-'))
    try {
      writeFileSync(path.join(workspace, 'legacy.css'), '.legacy-card { border-left: 2px solid; }')
      const baseline = designSourceQualityBaseline(workspace)
      expect(() => validateDesignSourceQuality(workspace, [], baseline)).not.toThrow()

      writeFileSync(path.join(workspace, 'new.css'), '.proof-card { border-left: 3px solid; }')
      expect(() => validateDesignSourceQuality(workspace, [], baseline)).toThrow(
        'new.css: .proof-card uses a one-sided card-edge border',
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects new SVG substitutes unless assets.json explicitly approves their functional role', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-svg-source-'))
    const emptyAssets = { version: 1 as const, assets: [] }
    try {
      writeFileSync(path.join(workspace, 'legacy.svg'), '<svg viewBox="0 0 10 10"></svg>')
      const baseline = designSourceQualityBaseline(workspace, emptyAssets)
      expect(() => validateDesignSourceQuality(workspace, [], baseline, emptyAssets)).not.toThrow()

      writeFileSync(path.join(workspace, 'brand-shape.svg'), '<svg viewBox="0 0 40 40"></svg>')
      expect(() => validateDesignSourceQuality(workspace, [], baseline, emptyAssets)).toThrow(
        'unmanifested standalone SVG substitute',
      )

      const deceptiveNeededAssets = {
        version: 1 as const,
        assets: [
          {
            id: 'brand-mark',
            kind: 'icon' as const,
            status: 'needed' as const,
            purpose: 'Unresolved mark.',
            requirements: [],
            role: 'logo' as const,
            sectionIds: ['hero'],
            destination: 'brand-shape.svg',
          },
        ],
      }
      expect(() =>
        validateDesignSourceQuality(workspace, [], baseline, deceptiveNeededAssets),
      ).toThrow('unmanifested standalone SVG substitute')

      const approvedAssets = {
        version: 1 as const,
        assets: [
          {
            id: 'brand-mark',
            kind: 'icon' as const,
            status: 'ready' as const,
            purpose: 'Existing functional brand mark.',
            requirements: [],
            role: 'logo' as const,
            sectionIds: ['hero'],
            source: { kind: 'project' as const, reference: 'brand-shape.svg' },
            destination: 'brand-shape.svg',
          },
        ],
      }
      expect(() =>
        validateDesignSourceQuality(workspace, [], baseline, approvedAssets),
      ).not.toThrow()

      writeFileSync(
        path.join(workspace, 'App.tsx'),
        'export const Art = () => <svg viewBox="0 0 100 100"><path d="M0 0h100v100z" /></svg>',
      )
      expect(() => validateDesignSourceQuality(workspace, [], baseline, approvedAssets)).toThrow(
        'unmanifested inline SVG substitute',
      )
      writeFileSync(
        path.join(workspace, 'ActionIcon.tsx'),
        'export const Icon = () => <svg viewBox="0 0 24 24"><path d="M4 12h16" /></svg>',
      )
      const inlineApproval = {
        ...approvedAssets,
        assets: [
          ...approvedAssets.assets,
          {
            ...approvedAssets.assets[0]!,
            id: 'action-icon',
            role: 'functional_icon' as const,
            source: { kind: 'project' as const, reference: 'ActionIcon.tsx' },
            destination: 'ActionIcon.tsx',
          },
        ],
      }
      expect(() => validateDesignSourceQuality(workspace, [], baseline, inlineApproval)).toThrow(
        'unmanifested inline SVG substitute',
      )
      rmSync(path.join(workspace, 'App.tsx'))
      expect(() =>
        validateDesignSourceQuality(workspace, [], baseline, inlineApproval),
      ).not.toThrow()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
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

  it('rejects new files inside pre-existing normal directories', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-exact-nested-extra-'))
    const brief = {
      ...artifacts[0],
      originalRequest: 'Create exactly index.html; do not create other files.',
    }
    try {
      mkdirSync(path.join(workspace, 'src'))
      writeFileSync(path.join(workspace, 'src', 'existing.ts'), 'pre-existing user file')
      const baseline = exactBuildFileBaseline(workspace, brief)

      writeFileSync(path.join(workspace, 'index.html'), '<main></main>')
      writeFileSync(path.join(workspace, 'src', 'unexpected.ts'), 'new file')

      expect(() => validateExactBuildFiles(workspace, brief, baseline)).toThrow(
        'unexpected files: src/unexpected.ts',
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('keeps internal metadata and dependency trees opaque', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-exact-opaque-'))
    const brief = {
      ...artifacts[0],
      originalRequest: 'Create exactly index.html; do not create other files.',
    }
    try {
      for (const directory of ['.git', '.taste', 'node_modules/package', '.pnpm-store/v3']) {
        mkdirSync(path.join(workspace, directory), { recursive: true })
        writeFileSync(path.join(workspace, directory, 'existing.json'), '{}')
      }
      const baseline = exactBuildFileBaseline(workspace, brief)

      writeFileSync(path.join(workspace, 'index.html'), '<main></main>')
      for (const directory of ['.git', '.taste', 'node_modules/package', '.pnpm-store/v3']) {
        writeFileSync(path.join(workspace, directory, 'created-during-build.json'), '{}')
      }

      expect(() => validateExactBuildFiles(workspace, brief, baseline)).not.toThrow()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects new files inside nested internal-named directories', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-exact-nested-internal-'))
    const brief = {
      ...artifacts[0],
      originalRequest: 'Create exactly index.html; do not create other files.',
    }
    try {
      mkdirSync(path.join(workspace, 'src'))
      const baseline = exactBuildFileBaseline(workspace, brief)

      writeFileSync(path.join(workspace, 'index.html'), '<main></main>')
      for (const directory of ['.git', '.taste']) {
        mkdirSync(path.join(workspace, 'src', directory))
        writeFileSync(path.join(workspace, 'src', directory, 'hidden.json'), '{}')
      }

      expect(() => validateExactBuildFiles(workspace, brief, baseline)).toThrow(
        'unexpected files: src/.git/hidden.json, src/.taste/hidden.json',
      )
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('accepts an expected file inside a nested directory', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-exact-nested-expected-'))
    const brief = {
      ...artifacts[0],
      originalRequest: 'Create exactly src/index.ts; do not create other files.',
    }
    try {
      mkdirSync(path.join(workspace, 'src'))
      const baseline = exactBuildFileBaseline(workspace, brief)
      writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export {}')

      expect(() => validateExactBuildFiles(workspace, brief, baseline)).not.toThrow()
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
