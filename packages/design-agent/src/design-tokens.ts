import type { BrandSystem } from './brand.js'
import {
  PALETTE_ROLES,
  paletteCssVariables,
  type PaletteRole,
  type PaletteRoles,
} from './palette.js'
import { DESIGN_FONT_POOLS } from './typography.js'

/** Custom properties Build declares once; every section reads only these. */
export interface DesignTokenVariables {
  /** Declared on :root. */
  root: Record<string, string>
  /** The dark palette when the brand defines both themes; light stays on :root. */
  dark?: Record<string, string>
}

export function designTokenVariables(brand: BrandSystem): DesignTokenVariables {
  const themes = paletteThemes(brand.colorPalette)
  const primary = themes.light ?? themes.dark
  const root: Record<string, string> = primary
    ? paletteCssVariables(primary)
    : Object.fromEntries(
        brand.colorPalette.map(({ name, value }) => [`--color-${slug(name)}`, value]),
      )

  brand.typefaces.forEach(({ family }, index) => {
    root[index === 0 ? '--font-primary' : '--font-secondary'] =
      `"${family.replace(/["\\]/gu, '')}", ${genericFamily(family)}`
  })

  // Brand parsing keeps only complete token groups; Build derives the missing ones.
  const { typeScale, radius, spacing } = brand.designTokens ?? {}
  if (typeScale) {
    for (const [step, size] of Object.entries(typeScale)) root[`--text-${step}`] = size
  }
  if (radius) {
    radius.scale.forEach((size, index) => {
      root[`--radius-${index + 1}`] = size
    })
    root['--radius-pill'] = radius.pill
  }
  if (spacing) {
    root['--space-section'] = spacing.section
    root['--space-gutter'] = spacing.gutter
    root['--space-stack'] = spacing.stack
  }

  return themes.light && themes.dark ? { root, dark: paletteCssVariables(themes.dark) } : { root }
}

/** Themes whose generated palette records contain every role. */
interface RecoveredPaletteThemes {
  light?: PaletteRoles
  dark?: PaletteRoles
}

/** Recovers generated palette roles from their records, such as "Light Surface alt". */
function paletteThemes(colors: BrandSystem['colorPalette']): RecoveredPaletteThemes {
  const found = { light: new Map<PaletteRole, string>(), dark: new Map<PaletteRole, string>() }
  for (const { name, value } of colors) {
    const match = /^(light|dark)\s+(.+)$/iu.exec(name.trim())
    if (!match) continue
    const role = match[2]!
      .toLowerCase()
      .replace(/\s+(\w)/gu, (_, letter: string) => letter.toUpperCase())
    if (!isPaletteRole(role)) continue
    found[match[1]!.toLowerCase() === 'dark' ? 'dark' : 'light'].set(role, value)
  }
  const light = completeRoles(found.light)
  const dark = completeRoles(found.dark)
  return { ...(light ? { light } : {}), ...(dark ? { dark } : {}) }
}

function completeRoles(roles: Map<PaletteRole, string>): PaletteRoles | undefined {
  if (!PALETTE_ROLES.every((role) => roles.has(role))) return undefined
  return Object.fromEntries(PALETTE_ROLES.map((role) => [role, roles.get(role)!])) as PaletteRoles
}

function isPaletteRole(value: string): value is PaletteRole {
  return PALETTE_ROLES.some((role) => role === value)
}

function genericFamily(family: string): string {
  const pool = Object.entries(DESIGN_FONT_POOLS).find(([, families]) =>
    (families as readonly string[]).includes(family),
  )?.[0]
  if (pool === 'mono' || (!pool && /\bmono\b/iu.test(family))) return 'monospace'
  if (pool === 'serif' || (!pool && /\bserif\b/iu.test(family) && !/\bsans\b/iu.test(family)))
    return 'serif'
  return 'sans-serif'
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '') || 'color'
  )
}
