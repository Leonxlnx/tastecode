import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseBrandSystem, type BrandSystem } from './brand.js'
import {
  cornerRadii,
  designConsistencyAudit,
  designConsistencyBaseline,
  fontFamilies,
} from './design-consistency.js'

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
})
