export const PALETTE_ROLES = [
  'canvas',
  'surface',
  'surfaceAlt',
  'text',
  'textMuted',
  'divider',
  'controlBorder',
  'accent',
  'accentHover',
  'onAccent',
  'accentText',
  'focusRing',
] as const

export type PaletteRole = (typeof PALETTE_ROLES)[number]
export type PaletteThemeName = 'light' | 'dark'
export type PaletteRoles = Record<PaletteRole, string>

export interface PaletteThemeDirection {
  accentSeed: string
  neutralSeed?: string
  surfaceContrast: 'quiet' | 'defined'
}

export interface PaletteRequest {
  themes: Partial<Record<PaletteThemeName, PaletteThemeDirection>>
  locked?: Partial<Record<PaletteThemeName, Partial<Record<PaletteRole, string>>>>
}

export interface PaletteContrastCheck {
  foreground: PaletteRole
  background: PaletteRole
  ratio: number
  minimum: 3 | 4.5
  criterion: 'WCAG 2.2 1.4.3' | 'WCAG 2.2 1.4.11'
  pass: boolean
}

export interface PaletteRepair {
  role: PaletteRole
  from: string
  to: string
  reason: 'contrast'
  affectedPairs: string[]
}

export interface PaletteTheme {
  direction: PaletteThemeDirection
  roles: PaletteRoles
  lockedRoles: PaletteRole[]
  repairs: PaletteRepair[]
  checks: PaletteContrastCheck[]
}

export interface ColorSystem {
  version: 1
  usageBalance: {
    dominant: Array<'canvas' | 'surface'>
    supporting: Array<'surfaceAlt'>
    accent: Array<'accent' | 'accentText'>
    guidance: string
  }
  themes: Partial<Record<PaletteThemeName, PaletteTheme>>
  evidenceScope: 'opaque-srgb-token-pairs'
}

export interface PaletteIssue {
  code:
    | 'invalid-request'
    | 'invalid-color'
    | 'unknown-role'
    | 'missing-theme-direction'
    | 'locked-contrast-conflict'
    | 'unrepairable-contrast'
  message: string
  theme?: PaletteThemeName
  roles?: PaletteRole[]
}

export type PaletteBuildResult =
  | { status: 'ready'; value: ColorSystem }
  | { status: 'blocked'; issues: PaletteIssue[]; partial?: ColorSystem }

const THEME_NAMES = ['light', 'dark'] as const
const ROLE_SET = new Set<string>(PALETTE_ROLES)
const HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/iu

const CONTRAST_PAIRS: Array<{
  foreground: PaletteRole
  background: PaletteRole
  minimum: 3 | 4.5
}> = [
  ...(['text', 'textMuted', 'accentText'] as const).flatMap((foreground) =>
    (['canvas', 'surface', 'surfaceAlt'] as const).map((background) => ({
      foreground,
      background,
      minimum: 4.5 as const,
    })),
  ),
  { foreground: 'onAccent', background: 'accent', minimum: 4.5 },
  { foreground: 'onAccent', background: 'accentHover', minimum: 4.5 },
  ...(['controlBorder', 'focusRing'] as const).flatMap((foreground) =>
    (['canvas', 'surface', 'surfaceAlt'] as const).map((background) => ({
      foreground,
      background,
      minimum: 3 as const,
    })),
  ),
]

const REPAIR_ORDER: PaletteRole[] = [
  'onAccent',
  'accentText',
  'textMuted',
  'text',
  'controlBorder',
  'focusRing',
  'accentHover',
  'accent',
  'surfaceAlt',
  'surface',
  'canvas',
]

const LIGHTNESS = {
  light: {
    canvas: 0.975,
    surface: 0.995,
    surfaceAlt: { quiet: 0.94, defined: 0.9 },
    text: 0.18,
    textMuted: 0.42,
    divider: { quiet: 0.88, defined: 0.82 },
    controlBorder: 0.52,
  },
  dark: {
    canvas: 0.12,
    surface: 0.17,
    surfaceAlt: { quiet: 0.22, defined: 0.28 },
    text: 0.94,
    textMuted: 0.7,
    divider: { quiet: 0.3, defined: 0.38 },
    controlBorder: 0.62,
  },
} as const

interface Oklch {
  l: number
  c: number
  h: number
}

interface ParsedRequest {
  themes: Partial<Record<PaletteThemeName, PaletteThemeDirection>>
  locked: Partial<Record<PaletteThemeName, Partial<Record<PaletteRole, string>>>>
}

export function generatePalette(input: unknown): PaletteBuildResult {
  const parsed = parseRequest(input)
  if ('issues' in parsed) return { status: 'blocked', issues: parsed.issues }

  const themes: ColorSystem['themes'] = {}
  const issues: PaletteIssue[] = []
  for (const name of THEME_NAMES) {
    const direction = parsed.value.themes[name]
    if (!direction) continue
    const result = buildTheme(name, direction, parsed.value.locked[name] ?? {})
    themes[name] = result.theme
    issues.push(...result.issues)
  }

  const value: ColorSystem = {
    version: 1,
    usageBalance: {
      dominant: ['canvas', 'surface'],
      supporting: ['surfaceAlt'],
      accent: ['accent', 'accentText'],
      guidance:
        'Use dominant surfaces, supporting structure, and a sparse accent. Treat 60/30/10 as an editorial check, never a pixel quota.',
    },
    themes,
    evidenceScope: 'opaque-srgb-token-pairs',
  }
  return issues.length ? { status: 'blocked', issues, partial: value } : { status: 'ready', value }
}

export function auditPalette(roles: PaletteRoles): {
  pass: boolean
  checks: PaletteContrastCheck[]
} {
  const checks = CONTRAST_PAIRS.map(({ foreground, background, minimum }) => {
    const ratio = contrast(roles[foreground], roles[background])
    return {
      foreground,
      background,
      ratio,
      minimum,
      criterion: minimum === 4.5 ? 'WCAG 2.2 1.4.3' : 'WCAG 2.2 1.4.11',
      pass: ratio >= minimum,
    } satisfies PaletteContrastCheck
  })
  return { pass: checks.every(({ pass }) => pass), checks }
}

export function paletteCssVariables(roles: PaletteRoles): Record<string, string> {
  return Object.fromEntries(
    PALETTE_ROLES.map((role) => [
      `--color-${role.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
      roles[role],
    ]),
  )
}

export function paletteColorRecords(system: ColorSystem): Array<{
  name: string
  value: string
  usage: string
}> {
  return THEME_NAMES.flatMap((theme) => {
    const palette = system.themes[theme]
    if (!palette) return []
    return PALETTE_ROLES.map((role) => ({
      name: `${capitalize(theme)} ${splitRole(role)}`,
      value: palette.roles[role],
      usage: `${splitRole(role)} token in the ${theme} theme.`,
    }))
  })
}

function parseRequest(input: unknown): { value: ParsedRequest } | { issues: PaletteIssue[] } {
  if (!isRecord(input) || !isRecord(input.themes)) {
    return {
      issues: [{ code: 'invalid-request', message: 'palette themes must be an object' }],
    }
  }
  const issues: PaletteIssue[] = []
  const themes: ParsedRequest['themes'] = {}
  const locked: ParsedRequest['locked'] = {}

  for (const name of THEME_NAMES) {
    const raw = input.themes[name]
    if (raw === undefined) continue
    if (!isRecord(raw)) {
      issues.push({
        code: 'missing-theme-direction',
        message: `${name} theme direction must be an object`,
        theme: name,
      })
      continue
    }
    const accentSeed = normalizeHex(raw.accentSeed)
    const neutralSeed = raw.neutralSeed === undefined ? undefined : normalizeHex(raw.neutralSeed)
    if (!accentSeed || (raw.neutralSeed !== undefined && !neutralSeed)) {
      issues.push({
        code: 'invalid-color',
        message: `${name} theme seeds must be opaque sRGB hex colors`,
        theme: name,
      })
      continue
    }
    if (raw.surfaceContrast !== 'quiet' && raw.surfaceContrast !== 'defined') {
      issues.push({
        code: 'invalid-request',
        message: `${name} surfaceContrast must be quiet or defined`,
        theme: name,
      })
      continue
    }
    themes[name] = {
      accentSeed,
      ...(neutralSeed ? { neutralSeed } : {}),
      surfaceContrast: raw.surfaceContrast,
    }
  }

  if (!THEME_NAMES.some((name) => themes[name])) {
    issues.push({
      code: 'missing-theme-direction',
      message: 'at least one light or dark theme direction is required',
    })
  }

  if (input.locked !== undefined) {
    if (!isRecord(input.locked)) {
      issues.push({ code: 'invalid-request', message: 'palette locked roles must be an object' })
    } else {
      for (const name of THEME_NAMES) {
        const raw = input.locked[name]
        if (raw === undefined) continue
        if (!themes[name]) {
          issues.push({
            code: 'missing-theme-direction',
            message: `${name} has locked roles but no theme direction`,
            theme: name,
          })
          continue
        }
        if (!isRecord(raw)) {
          issues.push({
            code: 'invalid-request',
            message: `${name} locked roles must be an object`,
            theme: name,
          })
          continue
        }
        const themeLocks: Partial<Record<PaletteRole, string>> = {}
        for (const [role, value] of Object.entries(raw)) {
          if (!ROLE_SET.has(role)) {
            issues.push({
              code: 'unknown-role',
              message: `${role} is not a palette role`,
              theme: name,
            })
            continue
          }
          const color = normalizeHex(value)
          if (!color) {
            issues.push({
              code: 'invalid-color',
              message: `${name}.${role} must be an opaque sRGB hex color`,
              theme: name,
              roles: [role as PaletteRole],
            })
            continue
          }
          themeLocks[role as PaletteRole] = color
        }
        locked[name] = themeLocks
      }
    }
  }

  return issues.length ? { issues } : { value: { themes, locked } }
}

function buildTheme(
  name: PaletteThemeName,
  direction: PaletteThemeDirection,
  locked: Partial<Record<PaletteRole, string>>,
): { theme: PaletteTheme; issues: PaletteIssue[] } {
  const accent = toOklch(direction.accentSeed)
  const neutral = toOklch(direction.neutralSeed ?? direction.accentSeed)
  const hue = neutral.c > 0.001 ? neutral.h : accent.h
  const target = LIGHTNESS[name]
  const neutralColor = (l: number, c: number) => fromOklch({ l, c: Math.min(neutral.c, c), h: hue })
  const accentColor = (l: number, c = accent.c) => fromOklch({ l, c, h: accent.h })

  const roles: PaletteRoles = {
    canvas: neutralColor(target.canvas, 0.025),
    surface: neutralColor(target.surface, 0.018),
    surfaceAlt: neutralColor(target.surfaceAlt[direction.surfaceContrast], 0.025),
    text: neutralColor(target.text, 0.015),
    textMuted: neutralColor(target.textMuted, 0.015),
    divider: neutralColor(target.divider[direction.surfaceContrast], 0.02),
    controlBorder: neutralColor(target.controlBorder, 0.025),
    accent: direction.accentSeed,
    accentHover: accentColor(clamp(accent.l + (name === 'light' ? -0.07 : 0.07), 0.03, 0.97)),
    onAccent: '#FFFFFF',
    accentText: accentColor(name === 'light' ? 0.38 : 0.72, Math.min(accent.c, 0.16)),
    focusRing: accentColor(name === 'light' ? 0.48 : 0.7, Math.min(accent.c, 0.18)),
  }

  Object.assign(roles, locked)
  const lockedRoles = PALETTE_ROLES.filter((role) => locked[role] !== undefined)
  const lockedSet = new Set(lockedRoles)
  const initial = auditPalette(roles)
  const conflicts = initial.checks.filter(
    (check) => !check.pass && lockedSet.has(check.foreground) && lockedSet.has(check.background),
  )
  if (conflicts.length) {
    return {
      theme: { direction, roles, lockedRoles, repairs: [], checks: initial.checks },
      issues: conflicts.map((check) => ({
        code: 'locked-contrast-conflict',
        message: `${name}.${check.foreground} on ${check.background} is ${check.ratio.toFixed(2)}:1; ${check.minimum}:1 is required`,
        theme: name,
        roles: [check.foreground, check.background],
      })),
    }
  }

  const repairs: PaletteRepair[] = []
  for (let iteration = 0; iteration < PALETTE_ROLES.length * 2; iteration += 1) {
    const current = auditPalette(roles)
    if (current.pass) {
      return {
        theme: { direction, roles, lockedRoles, repairs, checks: current.checks },
        issues: [],
      }
    }
    const candidate = bestRepair(roles, current.checks, lockedSet)
    if (!candidate) break
    const from = roles[candidate.role]
    roles[candidate.role] = candidate.color
    repairs.push({
      role: candidate.role,
      from,
      to: candidate.color,
      reason: 'contrast',
      affectedPairs: current.checks
        .filter(
          (check) =>
            !check.pass &&
            (check.foreground === candidate.role || check.background === candidate.role),
        )
        .map((check) => `${check.foreground}/${check.background}`),
    })
  }

  const audit = auditPalette(roles)
  return {
    theme: { direction, roles, lockedRoles, repairs, checks: audit.checks },
    issues: audit.checks
      .filter(({ pass }) => !pass)
      .map((check) => ({
        code: 'unrepairable-contrast',
        message: `${name}.${check.foreground} on ${check.background} is ${check.ratio.toFixed(2)}:1; ${check.minimum}:1 is required`,
        theme: name,
        roles: [check.foreground, check.background],
      })),
  }
}

function bestRepair(
  roles: PaletteRoles,
  checks: PaletteContrastCheck[],
  locked: Set<PaletteRole>,
): { role: PaletteRole; color: string } | undefined {
  const current = score(checks)
  let best:
    | { role: PaletteRole; color: string; failures: number; shortfall: number; distance: number }
    | undefined

  for (const role of REPAIR_ORDER) {
    if (
      locked.has(role) ||
      !checks.some(
        (check) => !check.pass && (check.foreground === role || check.background === role),
      )
    ) {
      continue
    }
    const source = toOklch(roles[role])
    for (let step = 0; step <= 500; step += 1) {
      const color = fromOklch({ ...source, l: step / 500 })
      if (color === roles[role]) continue
      const nextRoles = { ...roles, [role]: color }
      const next = score(auditPalette(nextRoles).checks)
      if (
        next.failures > current.failures ||
        (next.failures === current.failures && next.shortfall >= current.shortfall - 1e-9)
      ) {
        continue
      }
      const candidate = {
        role,
        color,
        ...next,
        distance: Math.abs(step / 500 - source.l),
      }
      if (!best || compareCandidate(candidate, best) < 0) best = candidate
    }
  }
  return best && { role: best.role, color: best.color }
}

function score(checks: PaletteContrastCheck[]): { failures: number; shortfall: number } {
  const failed = checks.filter(({ pass }) => !pass)
  return {
    failures: failed.length,
    shortfall: failed.reduce((total, check) => total + check.minimum - check.ratio, 0),
  }
}

function compareCandidate(
  left: { role: PaletteRole; color: string; failures: number; shortfall: number; distance: number },
  right: {
    role: PaletteRole
    color: string
    failures: number
    shortfall: number
    distance: number
  },
): number {
  return (
    left.failures - right.failures ||
    left.shortfall - right.shortfall ||
    left.distance - right.distance ||
    REPAIR_ORDER.indexOf(left.role) - REPAIR_ORDER.indexOf(right.role) ||
    left.color.localeCompare(right.color)
  )
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function luminance(value: string): number {
  const [red, green, blue] = rgb(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

function toOklch(value: string): Oklch {
  const [red, green, blue] = rgb(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  const l = Math.cbrt(0.4122214708 * red! + 0.5363325363 * green! + 0.0514459929 * blue!)
  const m = Math.cbrt(0.2119034982 * red! + 0.6806995451 * green! + 0.1073969566 * blue!)
  const s = Math.cbrt(0.0883024619 * red! + 0.2817188376 * green! + 0.6299787005 * blue!)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const chroma = Math.hypot(a, b)
  return {
    l: lightness,
    c: chroma,
    h: chroma < 1e-7 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
  }
}

function fromOklch(value: Oklch): string {
  let low = 0
  let high = value.c
  let best = linearRgb({ ...value, c: 0 })
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const chroma = (low + high) / 2
    const candidate = linearRgb({ ...value, c: chroma })
    if (candidate.every((channel) => channel >= 0 && channel <= 1)) {
      best = candidate
      low = chroma
    } else {
      high = chroma
    }
  }
  return `#${best
    .map((channel) =>
      Math.round(compand(clamp(channel, 0, 1)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase()
}

function linearRgb({ l, c, h }: Oklch): number[] {
  const angle = (h * Math.PI) / 180
  const a = c * Math.cos(angle)
  const b = c * Math.sin(angle)
  const lRoot = l + 0.3963377774 * a + 0.2158037573 * b
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * b
  const sRoot = l - 0.0894841775 * a - 1.291485548 * b
  const lCube = lRoot ** 3
  const mCube = mRoot ** 3
  const sCube = sRoot ** 3
  return [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ]
}

function compand(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
}

function rgb(value: string): number[] {
  const hex = normalizeHex(value)!
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
}

function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string' || !HEX.test(value)) return undefined
  const full =
    value.length === 4
      ? `#${[...value.slice(1)].map((character) => character.repeat(2)).join('')}`
      : value
  return full.toUpperCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`
}

function splitRole(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`)
}
