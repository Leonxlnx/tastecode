import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseBrandSystem, type BrandSystem } from './brand.js'
import {
  cornerRadii,
  DESIGN_RADIUS_VALUE_LIMIT,
  designConsistencyAudit,
  designConsistencyBaseline,
  designConsistencyFindings,
  enforceDesignConsistencyFindings,
  fontFamilies,
  type DesignConsistencyAudit,
} from './design-consistency.js'
import { enforceDomAuditFindings, type VisualReview } from './review-phase.js'

const roots: string[] = []

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-design-consistency-'))
  roots.push(root)
  write(root, files)
  return root
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), contents)
  }
}

function brand(families: string[], designTokens?: unknown): BrandSystem {
  const parsed = parseBrandSystem({
    version: 1,
    creativeDirection: { summary: 'Editorial', keywords: [], avoid: [] },
    colorPalette: [{ name: 'Ink', value: '#111111', usage: 'Text' }],
    typefaces: families.map((family) => ({
      family,
      source: 'Google Fonts',
      roles: ['body'],
      weights: [400],
    })),
    interfaceDirection: 'Editorial grid',
    imageDirection: { summary: 'None', subjects: [], treatment: 'None', avoid: [] },
    motionDirection: { summary: 'Minimal', principles: [], avoid: [] },
    voice: { summary: 'Direct', avoid: [] },
  })
  // brand.json parsing of designTokens lands separately; the audit reads it defensively.
  return designTokens === undefined ? parsed : ({ ...parsed, designTokens } as BrandSystem)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('font families in generated source', () => {
  it('reads the first family of CSS, style blocks, inline styles and shorthand', () => {
    expect(
      fontFamilies(`
        body { font-family: "Inter", system-ui, sans-serif; }
        h1 { font-family: 'Playfair Display' , serif !important }
        .label { font: 600 0.75rem/1.2 "Space Mono", monospace; }
        .lead { font: italic 1.25rem Fraunces, serif }
        <p style="font-family: Lora, serif; color: red">x</p>
        @font-face { font-family: "Clash Display"; src: url(clash.woff2) }
      `),
    ).toEqual(['Inter', 'Playfair Display', 'Lora', 'Clash Display', 'Space Mono', 'Fraunces'])
  })

  it('reads CSS-in-JS objects, Tailwind config and Tailwind v4 theme variables', () => {
    expect(
      fontFamilies(`
        const title = { fontFamily: '"Bricolage Grotesque", sans-serif' }
        const body = { fontFamily: ['Manrope', 'sans-serif'] }
        export default { theme: { extend: { fontFamily: {
          sans: ['"General Sans"', ...defaultTheme.fontFamily.sans],
          display: [['Syne', 'serif'], { fontFeatureSettings: '"ss01"' }],
          mono: 'JetBrains Mono, monospace',
        } } } }
        @theme { --font-heading: "Cabinet Grotesk", sans-serif; --font-size-lg: 1.25rem; --font-weight-bold: 700; }
        $font-accent: 'Instrument Serif', serif;
        <h2 className="font-['Big_Shoulders_Display'] font-[600]">x</h2>
      `),
    ).toEqual([
      'Cabinet Grotesk',
      'Instrument Serif',
      'Bricolage Grotesque',
      'Manrope',
      'General Sans',
      'Syne',
      'JetBrains Mono',
      'Big Shoulders Display',
    ])
  })

  it('reads Google Fonts, Fontshare, next/font/google and @fontsource loading', () => {
    expect(
      fontFamilies(`
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=DM+Serif+Display:ital@0;1&display=swap" rel="stylesheet">
        @import url('https://fonts.googleapis.com/css?family=Roboto:400,700|Open+Sans');
        <link href="https://api.fontshare.com/v2/css?f[]=clash-display@600&f[]=satoshi@400,700&display=swap">
        import { Inter_Tight, Playfair_Display as Display } from 'next/font/google'
        import '@fontsource/ibm-plex-mono/400.css'
        import '@fontsource-variable/onest'
      `),
    ).toEqual([
      'Inter',
      'DM Serif Display',
      'Roboto',
      'Open Sans',
      'Clash Display',
      'Satoshi',
      'Inter Tight',
      'Playfair Display',
      'Ibm Plex Mono',
      'Onest',
    ])
  })

  it('ignores variables, expressions, generic, system and icon families', () => {
    const workspacePath = workspace({
      'src/app.css': `
        :root { font-family: var(--font-sans); }
        body { font-family: system-ui, -apple-system, sans-serif; }
        code { font-family: ui-monospace, SFMono-Regular, monospace; }
        h1 { font-family: inherit; }
        .scss { font-family: $heading-font; }
        .theme { font-family: theme('fontFamily.display'); }
        .icon { font-family: 'Material Symbols Outlined'; }
        .fa { font-family: "Font Awesome 6 Free"; }
        .emoji { font-family: "Apple Color Emoji"; }
      `,
      'index.html':
        '<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded&amp;display=swap" rel="stylesheet">',
      'src/Title.tsx': 'export const Title = () => <h1 style={{ fontFamily: `${display}` }} />',
    })
    expect(designConsistencyAudit(workspacePath, brand(['Inter'])).fonts).toEqual([])
  })
})

describe('designConsistencyAudit fonts', () => {
  it('reports families outside the approved brand fonts with the files that use them', () => {
    const workspacePath = workspace({
      'index.html':
        '<link href="https://fonts.googleapis.com/css2?family=Inter&amp;family=Playfair+Display&amp;display=swap" rel="stylesheet"><style>h2 { font-family: "Space Mono", monospace }</style>',
      'src/hero.css': 'h1 { font-family: "Playfair Display", serif }',
      'src/body.css': 'body { font-family: "Inter Variable", sans-serif }',
      'src/stats.tsx': "export const Stat = () => <b style={{ fontFamily: 'Fraunces' }} />",
    })
    expect(designConsistencyAudit(workspacePath, brand(['Inter', 'Fraunces']))).toMatchObject({
      approvedFonts: ['Inter', 'Fraunces'],
      fonts: [
        { family: 'Playfair Display', files: ['index.html', 'src/hero.css'] },
        { family: 'Space Mono', files: ['index.html'] },
      ],
    })
  })

  it('does not blame fonts the project already declared at run start', () => {
    const workspacePath = workspace({
      'src/legacy.css': 'body { font-family: Georgia, serif } .x { font-family: "Comic Neue" }',
    })
    const baseline = designConsistencyBaseline(workspacePath)
    write(workspacePath, {
      'src/legacy.css':
        'body { font-family: Georgia, serif } .x { font-family: "Comic Neue" } .y { font-family: Georgia }',
      'src/hero.css': 'h1 { font-family: Georgia, serif } p { font-family: Inter }',
    })
    const audited = designConsistencyAudit(workspacePath, brand(['Inter']), baseline)
    expect(audited.fonts).toEqual([{ family: 'Georgia', files: ['src/hero.css'] }])
    expect(designConsistencyAudit(workspacePath, brand(['Inter'])).fonts).toEqual([
      { family: 'Comic Neue', files: ['src/legacy.css'] },
      { family: 'Georgia', files: ['src/hero.css', 'src/legacy.css'] },
    ])
  })

  it('cannot judge fonts without an approved brand family', () => {
    const workspacePath = workspace({ 'src/a.css': 'h1 { font-family: Lobster }' })
    expect(designConsistencyAudit(workspacePath).fonts).toEqual([])
    expect(
      designConsistencyAudit(workspacePath, { ...brand(['Inter']), typefaces: [] }).fonts,
    ).toEqual([])
  })

  it('skips dependencies, builds, tests and standalone SVG assets', () => {
    const workspacePath = workspace({
      'node_modules/pkg/index.css': 'body { font-family: Lobster }',
      'dist/app.css': 'body { font-family: Lobster }',
      'src/hero.test.tsx': "const style = { fontFamily: 'Lobster' }",
      'public/logo.svg':
        '<svg><style>text { font-family: Lobster; border-radius: 3px }</style></svg>',
    })
    expect(designConsistencyAudit(workspacePath, brand(['Inter']))).toMatchObject({
      fonts: [],
      radii: [],
    })
  })
})

describe('designConsistencyAudit radii', () => {
  it('reads CSS, inline styles, CSS-in-JS and Tailwind utilities in one canonical unit', () => {
    expect(
      cornerRadii(`
        .card { border-radius: 0.5rem; }
        .media { border-top-left-radius: 12px; border-radius: 12px 12px 0 0 }
        .blob { border-radius: 20px / 10px }
        .pill { border-radius: 999px } .dot { border-radius: 50% } .flat { border-radius: 0 }
        .token { border-radius: var(--radius-2) } .nested { border-radius: calc(var(--r) - 4px) }
        const panel = { borderRadius: 6, borderTopRightRadius: '1.5rem', other: theme.radius }
        <div className="rounded-xl md:rounded-2xl rounded-t-[14px] rounded-full rounded-none" />
        <a class="rounded px-4">Rounded corners are a rounded word in copy</a>
      `),
    ).toEqual([
      '8px',
      '12px',
      '12px',
      '12px',
      '20px',
      '10px',
      '6px',
      '24px',
      '12px',
      '16px',
      '14px',
      '4px',
    ])
  })

  it('lists the distinct non-pill radii the run introduced, small to large', () => {
    const workspacePath = workspace({ 'src/old.css': '.old { border-radius: 3px }' })
    const baseline = designConsistencyBaseline(workspacePath)
    write(workspacePath, {
      'src/a.css':
        '.a { border-radius: 4px } .b { border-radius: 8px } .c { border-radius: 9999px }',
      'src/b.tsx': 'export const B = () => <div className="rounded-xl rounded-2xl rounded-full" />',
    })
    expect(designConsistencyAudit(workspacePath, undefined, baseline).radii).toEqual([
      { value: '4px', files: ['src/a.css'] },
      { value: '8px', files: ['src/a.css'] },
      { value: '12px', files: ['src/b.tsx'] },
      { value: '16px', files: ['src/b.tsx'] },
    ])
    write(workspacePath, { 'src/c.css': '.c { border-radius: 20px } .d { border-radius: 2px }' })
    expect(
      designConsistencyAudit(workspacePath, undefined, baseline).radii.map(({ value }) => value),
    ).toEqual(['2px', '4px', '8px', '12px', '16px', '20px'])
  })

  it('compares radii with brand radius tokens when the brand records them', () => {
    const workspacePath = workspace({
      'src/a.css':
        ':root { --radius-1: 6px } .a { border-radius: 6px } .b { border-radius: 0.75rem } .c { border-radius: 10px } .d { border-radius: 999px }',
    })
    expect(
      designConsistencyAudit(
        workspacePath,
        brand(['Inter'], { radius: { scale: ['6px', '12px'], pill: '999px' } }),
      ),
    ).toMatchObject({ radiusTokens: ['6px', '12px'], radiiOutsideTokens: ['10px'] })
    expect(
      designConsistencyAudit(workspacePath, brand(['Inter'], { radius: ['0.375rem', 12] })),
    ).toMatchObject({ radiusTokens: ['6px', '12px'], radiiOutsideTokens: ['10px'] })
    for (const designTokens of [{}, { radius: 'large' }, { radius: { scale: 'x' } }, 'tokens']) {
      const audited = designConsistencyAudit(workspacePath, brand(['Inter'], designTokens))
      expect(audited.radiusTokens).toBeUndefined()
      expect(audited.radiiOutsideTokens).toEqual([])
    }
  })

  it('resolves named Tailwind radii through the theme the workspace maps to its tokens', () => {
    const tokens = { radius: { scale: ['10px', '16px', '24px'] } }
    const v4 = workspace({
      'src/index.css': `:root { --radius-1: 10px; --radius-2: 16px; --radius-3: 24px }
        @theme { --radius-md: var(--radius-1); --radius-lg: var(--radius-2);
          --radius-xl: var(--radius-3); --radius-2xl: 1.5rem }`,
    })
    const baseline = designConsistencyBaseline(v4)
    write(v4, {
      'src/Hero.tsx':
        'export const Hero = () => <div className="rounded-md rounded-lg rounded-xl rounded-2xl" />',
    })
    const audit = designConsistencyAudit(v4, brand(['Inter'], tokens), baseline)
    expect(audit.radii).toEqual([{ value: '24px', files: ['src/Hero.tsx'] }])
    expect(designConsistencyFindings(audit)).toEqual([])
    write(v4, { 'src/Card.tsx': 'export const Card = () => <div className="rounded-sm" />' })
    expect(
      designConsistencyAudit(v4, brand(['Inter'], tokens), baseline).radiiOutsideTokens,
    ).toEqual(['4px'])

    const v3 = workspace({
      'tailwind.config.ts': `export default { theme: { extend: { borderRadius: {
        lg: 'var(--radius)', md: "calc(var(--radius) - 2px)", sm: \`calc(var(--radius) - 4px)\`,
        DEFAULT: '0.625rem', '2xl': '1rem', ...preset.borderRadius,
      } } } }`,
      'src/App.tsx':
        'export const App = () => <div className="rounded rounded-sm rounded-md rounded-lg rounded-xl rounded-2xl" />',
    })
    expect(designConsistencyAudit(v3).radii.map(({ value }) => value)).toEqual([
      '10px',
      '12px',
      '16px',
    ])
  })
})

describe('design consistency review findings', () => {
  const clean: DesignConsistencyAudit = {
    approvedFonts: ['Inter'],
    fonts: [],
    radii: [],
    radiiOutsideTokens: [],
  }
  const radii = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      value: `${(index + 1) * 2}px`,
      files: [`src/section-${index % 2}.css`],
    }))
  const passing: VisualReview = {
    version: 1,
    verdict: 'pass',
    summary: 'Matches the references.',
    findings: [],
  }

  it('names the off-brand families, their files and the approved fonts', () => {
    const [finding, ...rest] = designConsistencyFindings({
      ...clean,
      approvedFonts: ['Inter', 'Fraunces'],
      fonts: [
        { family: 'Playfair Display', files: ['index.html', 'src/hero.css'] },
        { family: 'Space Mono', files: ['src/stats.tsx'] },
      ],
    })
    expect(rest).toEqual([])
    expect(finding).toEqual({
      id: 'font_family_drift',
      severity: 'major',
      area: 'Typography across the page',
      evidenceType: 'automated',
      confidence: 'high',
      evidence:
        'Generated source uses font families outside the approved brand fonts Inter, Fraunces: Playfair Display (index.html, src/hero.css), Space Mono (src/stats.tsx).',
      repair: expect.stringMatching(
        /^Replace Playfair Display, Space Mono with the approved brand fonts Inter, Fraunces, and remove their loading/,
      ),
    })
  })

  it(`flags more than ${DESIGN_RADIUS_VALUE_LIMIT} distinct radii only without brand tokens`, () => {
    expect(
      designConsistencyFindings({ ...clean, radii: radii(DESIGN_RADIUS_VALUE_LIMIT) }),
    ).toEqual([])
    const [finding] = designConsistencyFindings({
      ...clean,
      radii: radii(DESIGN_RADIUS_VALUE_LIMIT + 1),
    })
    expect(finding).toMatchObject({
      id: 'radius_scale_drift',
      severity: 'minor',
      evidenceType: 'automated',
      evidence:
        'Generated source uses 6 distinct corner radii (2px, 4px, 6px, 8px, 10px, 12px) in src/section-0.css, src/section-1.css; one page keeps one radius family of at most 5 values plus a pill.',
    })
    expect(
      designConsistencyFindings({
        ...clean,
        radii: radii(8),
        radiusTokens: ['2px', '4px', '6px', '8px', '10px', '12px', '14px', '16px'],
      }),
    ).toEqual([])
    expect(
      designConsistencyFindings({
        ...clean,
        radii: radii(2),
        radiusTokens: ['2px'],
        radiiOutsideTokens: ['4px'],
      }),
    ).toMatchObject([
      {
        id: 'radius_scale_drift',
        evidence:
          'Generated source uses corner radii outside the brand radius tokens 2px: 4px (src/section-1.css).',
        repair: expect.stringContaining('Replace 4px with the nearest brand radius token (2px)'),
      },
    ])
  })

  it('bounds long lists in finding text', () => {
    const [finding] = designConsistencyFindings({
      ...clean,
      fonts: Array.from({ length: 9 }, (_, index) => ({
        family: `Family ${index}`,
        files: ['a.css', 'b.css', 'c.css', 'd.css', 'e.css'],
      })),
    })
    expect(finding?.evidence).toContain('Family 0 (a.css, b.css, c.css and 2 more)')
    expect(finding?.evidence).toContain('Family 5 (a.css, b.css, c.css and 2 more) and 3 more.')
    expect(finding?.evidence).not.toContain('Family 6')
  })

  it('turns a passing review into a bounded repair and replaces stale audit findings', () => {
    expect(enforceDesignConsistencyFindings(passing, clean)).toBe(passing)
    const audit = { ...clean, fonts: [{ family: 'Lobster', files: ['src/a.css'] }] }
    const enforced = enforceDesignConsistencyFindings(passing, audit)
    expect(enforced).toMatchObject({
      verdict: 'repair',
      summary: 'Matches the references. TasteCode source audit found 1 design-language finding.',
      findings: [{ id: 'font_family_drift', evidence: expect.stringContaining('Lobster') }],
    })
    const stale = {
      id: 'font_family_drift',
      severity: 'minor' as const,
      area: 'Fonts',
      evidenceType: 'visual_inspection' as const,
      confidence: 'low' as const,
      evidence: 'Model guess',
      repair: 'Guess',
    }
    const visual = { ...stale, id: 'hero_clip', evidence: 'Clipped hero' }
    expect(
      enforceDesignConsistencyFindings(
        { ...passing, verdict: 'repair', findings: [visual, stale] },
        audit,
      ).findings.map(({ id, evidence }) => [id, evidence.slice(0, 20)]),
    ).toEqual([
      ['hero_clip', 'Clipped hero'],
      ['font_family_drift', 'Generated source use'],
    ])
  })

  it('lets the DOM audit drop model findings that use the source audit IDs', () => {
    const screenshots = [
      {
        path: 'desktop.png',
        width: 1440,
        height: 1000,
        domAudit: { h1Count: 2, interactiveTargetViolations: [] },
      },
      { path: 'mobile.png', width: 390, height: 844 },
    ]
    const review = enforceDomAuditFindings(
      {
        ...passing,
        verdict: 'repair',
        findings: [
          {
            id: 'radius_scale_drift',
            severity: 'minor',
            area: 'Cards',
            evidenceType: 'visual_inspection',
            confidence: 'low',
            evidence: 'Model guess',
            repair: 'Guess',
          },
        ],
      },
      screenshots,
    )
    expect(review.findings.map(({ id }) => id)).toEqual(['document_h1_count'])
  })
})
