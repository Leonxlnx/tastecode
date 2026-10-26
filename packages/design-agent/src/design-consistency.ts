import path from 'node:path'
import type { BrandSystem } from './brand.js'
import type { VisualReview } from './review-phase.js'
import { designSourceFiles } from './source-quality.js'
import { readWorkspaceFile } from './workspace-files.js'

const MAX_SOURCE_SCAN_BYTES = 32_000_000
const MAX_LITERAL_LENGTH = 2_000
const MAX_BLOCK_LENGTH = 20_000
const MAX_LISTED = 6

/** More distinct corner radii than this reads as several radius families on one page. */
export const DESIGN_RADIUS_VALUE_LIMIT = 5

/** Review finding IDs owned by the source audit; a model-written finding with one is replaced. */
export const DESIGN_CONSISTENCY_FINDING_IDS = ['font_family_drift', 'radius_scale_drift'] as const

type ReviewFinding = VisualReview['findings'][number]

/**
 * What the run introduced against one design language: font families outside the approved brand
 * fonts and the corner radii the generated source declares. Pre-existing declarations recorded in
 * the run-start baseline never count.
 */
export interface DesignConsistencyAudit {
  /** Approved brand families as written in brand.json; empty when the brand is unknown. */
  approvedFonts: string[]
  /** Families outside the brand, each with the files that declare or load it. */
  fonts: Array<{ family: string; files: string[] }>
  /** Distinct non-zero, non-pill corner radii, each with the files that use it. */
  radii: Array<{ value: string; files: string[] }>
  /** brand.designTokens radius values when the brand records them. */
  radiusTokens?: string[]
  /** Values in `radii` that are not one of `radiusTokens`. */
  radiiOutsideTokens: string[]
}

interface Declaration {
  kind: 'font' | 'radius'
  file: string
  key: string
  label: string
}

/** Run-start inventory: per file, every font family and corner radius it already declares. */
export function designConsistencyBaseline(workspacePath: string): string[] {
  return [...new Set(collectDeclarations(workspacePath).map(declarationKey))].sort()
}

/**
 * Compare the generated source with the approved brand. Without a brand only radii are judged,
 * because there is no approved font list to compare against.
 */
export function designConsistencyAudit(
  workspacePath: string,
  brand?: BrandSystem,
  baseline: readonly string[] = [],
): DesignConsistencyAudit {
  const existing = new Set(baseline)
  const introduced = collectDeclarations(workspacePath).filter(
    (declaration) => !existing.has(declarationKey(declaration)),
  )
  const approvedFonts = (brand?.typefaces ?? []).map(({ family }) => family)
  const allowed = new Set(
    approvedFonts.flatMap((family) => {
      const key = familyKey(firstFamily(family) ?? family)
      return key ? [key, withoutVariantSuffix(key)] : []
    }),
  )
  const fonts = allowed.size
    ? grouped(
        introduced.filter(
          ({ kind, key }) =>
            kind === 'font' && !allowed.has(key) && !allowed.has(withoutVariantSuffix(key)),
        ),
      ).map(({ label, files }) => ({ family: label, files }))
    : []
  const radii = grouped(introduced.filter(({ kind }) => kind === 'radius'))
    .map(({ label, files }) => ({ value: label, files }))
    .sort((a, b) => radiusOrder(a.value) - radiusOrder(b.value))
  const radiusTokens = brandRadiusTokens(brand)
  return {
    approvedFonts,
    fonts,
    radii,
    ...(radiusTokens ? { radiusTokens } : {}),
    radiiOutsideTokens: radiusTokens
      ? radii.map(({ value }) => value).filter((value) => !radiusTokens.includes(value))
      : [],
  }
}

export interface DesignConsistencyOptions {
  /**
   * False on an app screen: the tasteskill kit it copies (app.css, charts.js) keeps a fixed set
   * of small radii for chips, ticks and tooltips that no four-value brand scale can hold, and
   * Review judges panel radii against the dealt sheet instead.
   */
  radii?: boolean
}

/** Concise, actionable automated Review findings for the drift an audit found. */
export function designConsistencyFindings(
  audit: DesignConsistencyAudit,
  { radii = true }: DesignConsistencyOptions = {},
): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  if (audit.fonts.length) {
    const approved = audit.approvedFonts.join(', ')
    const families = audit.fonts.map(({ family }) => family)
    findings.push({
      id: 'font_family_drift',
      severity: 'major',
      area: 'Typography across the page',
      evidenceType: 'automated',
      confidence: 'high',
      evidence: `Generated source uses font families outside the approved brand fonts ${approved}: ${listed(
        audit.fonts.map(({ family, files }) => `${family} (${listed(files, 3)})`),
      )}.`,
      repair: `Replace ${listed(families)} with the approved brand fonts ${approved}, and remove their loading (Google Fonts links or @import, @font-face, next/font or @fontsource imports), so every section uses the one brand type system.`,
    })
  }
  if (!radii) return findings
  const files = [...new Set(audit.radii.flatMap(({ files }) => files))].sort()
  if (audit.radiusTokens && audit.radiiOutsideTokens.length) {
    const tokens = audit.radiusTokens.join(', ')
    const outside = new Set(audit.radiiOutsideTokens)
    findings.push({
      id: 'radius_scale_drift',
      severity: 'minor',
      area: 'Corner radii across the page',
      evidenceType: 'automated',
      confidence: 'medium',
      evidence: `Generated source uses corner radii outside the brand radius tokens ${tokens}: ${listed(
        audit.radii
          .filter(({ value }) => outside.has(value))
          .map(({ value, files }) => `${value} (${listed(files, 3)})`),
      )}.`,
      repair: `Replace ${listed(audit.radiiOutsideTokens)} with the nearest brand radius token (${tokens}) from the shared tokens block, so every section uses one radius family.`,
    })
  } else if (!audit.radiusTokens && audit.radii.length > DESIGN_RADIUS_VALUE_LIMIT) {
    findings.push({
      id: 'radius_scale_drift',
      severity: 'minor',
      area: 'Corner radii across the page',
      evidenceType: 'automated',
      confidence: 'medium',
      evidence: `Generated source uses ${audit.radii.length} distinct corner radii (${listed(
        audit.radii.map(({ value }) => value),
        12,
      )}) in ${listed(files, 4)}; one page keeps one radius family of at most ${DESIGN_RADIUS_VALUE_LIMIT} values plus a pill.`,
      repair: `Consolidate corner radii onto one shared scale of at most ${DESIGN_RADIUS_VALUE_LIMIT} values, declared once as tokens and reused by every section, instead of per-section literals.`,
    })
  }
  return findings
}

/**
 * Add the audit's findings to a parsed Review. Like the DOM audit they force a repair verdict, so
 * the run's existing repair limit bounds them; they never fail or restart the run.
 */
export function enforceDesignConsistencyFindings(
  review: VisualReview,
  audit: DesignConsistencyAudit,
  options: DesignConsistencyOptions = {},
): VisualReview {
  const automated = designConsistencyFindings(audit, options)
  if (!automated.length) return review
  const owned = new Set<string>(DESIGN_CONSISTENCY_FINDING_IDS)
  return {
    ...review,
    verdict: 'repair',
    summary: `${review.summary} TasteCode source audit found ${automated.length} design-language finding${automated.length === 1 ? '' : 's'}.`,
    findings: [...review.findings.filter(({ id }) => !owned.has(id)), ...automated],
  }
}

function listed(values: readonly string[], limit = MAX_LISTED): string {
  return values.length > limit
    ? `${values.slice(0, limit).join(', ')} and ${values.length - limit} more`
    : values.join(', ')
}

/** Small to large; expressions such as clamp() sort after plain lengths. */
function radiusOrder(value: string): number {
  const amount = Number.parseFloat(value)
  return Number.isFinite(amount) ? amount : Number.MAX_SAFE_INTEGER
}

function declarationKey({ kind, file, key }: Declaration): string {
  return `${file}: ${kind === 'font' ? 'font-family' : 'border-radius'} ${key}`
}

function grouped(declarations: readonly Declaration[]): Array<{ label: string; files: string[] }> {
  const groups = new Map<string, { label: string; files: Set<string> }>()
  for (const { key, label, file } of declarations) {
    const group = groups.get(key) ?? { label, files: new Set<string>() }
    group.files.add(file)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map(({ label, files }) => ({ label, files: [...files].sort() }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
}

function collectDeclarations(workspacePath: string): Declaration[] {
  const sources: Array<{ file: string; source: string }> = []
  let totalBytes = 0
  for (const file of designSourceFiles(workspacePath)) {
    const extension = path.extname(file).toLowerCase()
    // Standalone SVG is an asset (logo, icon, diagram), not the page's type or radius system.
    if (extension === '.svg') continue
    const bytes = readWorkspaceFile(path.join(workspacePath, file), MAX_SOURCE_SCAN_BYTES)
    totalBytes += bytes.length
    if (totalBytes > MAX_SOURCE_SCAN_BYTES)
      throw new Error('Design source scan exceeds 32 MB; reduce the workspace scope')
    let source = bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    if (extension === '.html' || extension === '.vue' || extension === '.svelte') {
      source = source
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/&quot;|&#0*34;/gi, '"')
        .replace(/&#0*39;|&apos;/gi, "'")
        .replace(/&amp;/gi, '&')
    }
    sources.push({ file, source })
  }
  // A named Tailwind radius means what the workspace theme maps it to, wherever that is declared.
  const theme = new Map(sources.flatMap(({ source }) => [...tailwindRadiusTheme(source)]))
  const declarations = new Map<string, Declaration>()
  for (const { file, source } of sources) {
    const add = (kind: Declaration['kind'], key: string, label: string) => {
      const declaration = { kind, file, key, label }
      const id = declarationKey(declaration)
      if (!declarations.has(id)) declarations.set(id, declaration)
    }
    for (const family of fontFamilies(source)) {
      if (!ignoredFamily(family)) add('font', familyKey(family), family)
    }
    for (const radius of cornerRadii(source, theme)) add('radius', radius, radius)
  }
  return [...declarations.values()]
}

// ---- Font families ------------------------------------------------------------------------

const GENERIC_FAMILIES = new Set([
  'serif',
  'sansserif',
  'monospace',
  'cursive',
  'fantasy',
  'systemui',
  'math',
  'emoji',
  'fangsong',
  'applesystem',
  'blinkmacsystemfont',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revertlayer',
  'default',
  'none',
  'normal',
  'italic',
  'oblique',
  'bold',
  'bolder',
  'lighter',
  'smallcaps',
  'auto',
  'swap',
  'applecoloremoji',
  'segoeuiemoji',
  'segoeuisymbol',
  'notocoloremoji',
  'notoemoji',
  'twemojimozilla',
  'androidemoji',
  'emojione',
])

const ICON_FONT =
  /icon|^materialsymbols|^fontawesome|^fa(?:\d|solid|regular|brands|light|thin|duotone|sharp)|^phosphor|^lucide|^remix|^feather$|^lineawesome|^glyphicons|^codicon|^octicon|^themify|^typicons|^icomoon|^iconoir|^tabler/

/** Variable-name segments that may hold a family; font settings are excluded below. */
const FONT_VARIABLE_SEGMENT = /^(?:fonts?|ff|famil\w*|typeface\w*|font\w+)$/i
const FONT_SETTING =
  /size|weight|wght|style|variant|stretch|feature|settings|variation|kerning|smooth|synthesis|leading|tracking|line|height|spacing|letter|scale|optical|opsz|step|ratio|base|min|max|fluid|(?:^|[-_])(?:lh|ls|fw|fs)(?:$|[-_])/i

export function fontFamilies(source: string): string[] {
  const families: string[] = []
  const add = (value: string | undefined) => {
    const family = value === undefined ? undefined : firstFamily(value)
    if (family) families.push(family)
  }

  // CSS, <style>, inline style attributes and CSS-in-JS template literals.
  for (const match of source.matchAll(/(?<![\w-])font-family['"]?\s*:\s*([^;{}<>\n]*)/gi)) {
    add(match[1])
  }
  for (const match of source.matchAll(/(?<![\w-])font['"]?\s*:\s*([^;{}<>\n]*)/gi)) {
    add(shorthandFamilies(match[1] ?? ''))
  }
  // Custom properties and preprocessor variables that hold a family, e.g. Tailwind v4 @theme.
  for (const match of source.matchAll(/(?<![\w$@-])(?:--|\$|@)([\w-]+)\s*:\s*([^;{}<>\n]*)/g)) {
    const name = match[1]!
    if (
      name.split(/[-_]/).some((segment) => FONT_VARIABLE_SEGMENT.test(segment)) &&
      !FONT_SETTING.test(name)
    ) {
      add(match[2])
    }
  }
  // CSS-in-JS objects and Tailwind config: fontFamily: 'X' | ['X', ...] | { sans: ['X'], ... }.
  for (const match of source.matchAll(/\bfontFamily\s*:\s*/g)) {
    const start = match.index + match[0].length
    const opening = source[start]
    if (opening === '{' || opening === '[') {
      const end = balancedEnd(source, start)
      if (end === undefined) continue
      const body = source.slice(start + 1, end - 1)
      const values = opening === '{' ? topLevelEntries(body).map(({ value }) => value) : [body]
      for (const value of values) add(firstStringLiteral(value))
    } else {
      add(stringLiteralAt(source, start))
    }
  }
  // Tailwind arbitrary family utilities: font-['Playfair_Display'] or font-[family-name:Inter].
  for (const match of source.matchAll(/(?<![\w-])font-\[(?:family-name:)?([^\]\s]+)\]/g)) {
    add(match[1]!.replaceAll('_', ' '))
  }
  // Google Fonts and Bunny Fonts stylesheets in <link> or @import.
  for (const match of source.matchAll(
    /(?:fonts\.googleapis\.com|fonts\.bunny\.net)\/css2?\?([^\s"'`)<>]+)/gi,
  )) {
    for (const parameter of match[1]!.split('&')) {
      const [name, value = ''] = parameter.split('=')
      if (name?.toLowerCase() !== 'family') continue
      for (const entry of decoded(value).split('|')) add(quoted(entry.split(':')[0] ?? ''))
    }
  }
  // Fontshare stylesheets: api.fontshare.com/v2/css?f[]=clash-display@600.
  for (const match of source.matchAll(/api\.fontshare\.com\/v\d+\/css\?([^\s"'`)<>]+)/gi)) {
    for (const parameter of match[1]!.split('&')) {
      const [name, value = ''] = parameter.split('=')
      if (!/^f(?:\[\]|%5B%5D)$/i.test(name ?? '')) continue
      add(quoted(slugLabel(decoded(value).split('@')[0] ?? '')))
    }
  }
  // next/font/google: import { Inter, Playfair_Display as Display } from 'next/font/google'.
  for (const match of source.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]next\/font\/google['"]/g,
  )) {
    for (const specifier of match[1]!.split(',')) {
      const name = specifier
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
      if (name) add(quoted(name.replaceAll('_', ' ')))
    }
  }
  // @fontsource/inter, @fontsource-variable/playfair-display/400.css.
  for (const match of source.matchAll(/@fontsource(?:-variable)?\/([a-z0-9-]+)/gi)) {
    add(quoted(slugLabel(match[1]!)))
  }
  return families
}

/** The first family in a CSS font-family list, without quotes; undefined for expressions. */
function firstFamily(value: string): string | undefined {
  const text = value.trim()
  const literal = /^(['"])(.*?)\1/.exec(text)
  const family = (literal ? literal[2]! : (/^[^,;!"'`{}()\n]*/.exec(text)?.[0] ?? ''))
    .trim()
    .replace(/\s+/g, ' ')
  if (
    !family ||
    /[()$@#{}\\]/.test(family) ||
    (!literal && /^[\w-]+\(/.test(text)) ||
    // A weight or length such as font-[600] or --font-size: 1.25rem is never a family.
    /^[\d.]+[a-z%]*$/i.test(family)
  ) {
    return undefined
  }
  return family
}

/** The family list of a `font` shorthand: everything after the size and line height. */
function shorthandFamilies(value: string): string | undefined {
  const text = value.trim()
  if (/^['"`{[]/.test(text)) return undefined
  const tokens = topLevelTokens(text)
  const size = tokens.findIndex((token) =>
    /^(?:[\d.]+(?:px|r?em|%|pt|pc|vw|vh|vmin|vmax|ch|ex|lh|rlh|cqw|cqi|q|mm|cm|in)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|(?:calc|clamp|min|max|var)\(.*\))(?:\/.*)?$/i.test(
      token,
    ),
  )
  if (size < 0) return undefined
  let index = size + 1
  if (tokens[index] === '/') index += 2
  else if (tokens[index]?.startsWith('/')) index += 1
  const families = tokens.slice(index).join(' ')
  return families || undefined
}

function ignoredFamily(family: string): boolean {
  const key = familyKey(family)
  return (
    !key ||
    family.trim().toLowerCase().startsWith('ui-') ||
    GENERIC_FAMILIES.has(key) ||
    ICON_FONT.test(key) ||
    /^\d+[a-z%]*$/.test(key)
  )
}

function familyKey(family: string): string {
  return family
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** "Inter Variable", "InterVar" and "Inter Fallback" are the brand's Inter, not another family. */
function withoutVariantSuffix(key: string): string {
  return key.replace(/(?:variable|var|vf|fallback|webfont|web)$/, '') || key
}

function slugLabel(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

function quoted(family: string): string {
  return `"${family.trim().replaceAll('"', '')}"`
}

function decoded(value: string): string {
  const spaced = value.replaceAll('+', ' ')
  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}

// ---- Corner radii -------------------------------------------------------------------------

/** Tailwind v4 default radius scale; v3 differs only in `sm`. `none` and `full` never count. */
const TAILWIND_RADII = new Map([
  ['xs', '2px'],
  ['sm', '4px'],
  ['md', '6px'],
  ['lg', '8px'],
  ['xl', '12px'],
  ['2xl', '16px'],
  ['3xl', '24px'],
  ['4xl', '32px'],
])
const TAILWIND_DEFAULT_RADIUS = '4px'
const TAILWIND_SIDE = '(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?'
const TAILWIND_ROUNDED = new RegExp(
  `(?<![\\w-])rounded${TAILWIND_SIDE}-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full|\\[[^\\]\\s]+\\])(?![\\w-])`,
  'g',
)
const BARE_ROUNDED = new RegExp(`^rounded${TAILWIND_SIDE}$`)
const TAILWIND_THEME_RADIUS = /(?<![\w-])--radius-(xs|sm|md|lg|xl|2xl|3xl|4xl)\s*:\s*([^;{}]*)/g

/**
 * Named radius sizes the workspace's own Tailwind theme redefines: v4 `--radius-<size>` variables
 * and a config's `borderRadius` object, where `DEFAULT` is bare `rounded`. Build maps brand radius
 * tokens this way, so `rounded-lg` then means the mapped value rather than Tailwind's default. A
 * value the audit cannot read, such as an imported constant, maps to undefined and never counts.
 */
function tailwindRadiusTheme(source: string): Map<string, string | undefined> {
  const theme = new Map<string, string | undefined>()
  for (const match of source.matchAll(TAILWIND_THEME_RADIUS)) theme.set(match[1]!, match[2]!)
  for (const match of source.matchAll(/\bborderRadius\s*:\s*\{/g)) {
    const start = match.index + match[0].length - 1
    const end = balancedEnd(source, start)
    if (end === undefined) continue
    for (const { key, value } of topLevelEntries(source.slice(start + 1, end - 1))) {
      theme.set(key.replace(/^(["'`])(.*)\1$/s, '$2'), stringLiteralAt(value.trim(), 0))
    }
  }
  return theme
}

export function cornerRadii(
  source: string,
  theme: ReadonlyMap<string, string | undefined> = new Map(),
): string[] {
  const radii: string[] = []
  const addValue = (value: string) => {
    for (const token of topLevelTokens(value.replace(/["'`]/g, ' ').replace(/!important/gi, ''))) {
      // `12px/8px` is an elliptical radius; a slash inside calc() is division.
      for (const part of token.includes('(') ? [token] : token.split('/')) {
        const radius = canonicalRadius(part)
        if (radius) radii.push(radius)
      }
    }
  }
  const addNamed = (size: string, fallback: string | undefined) => {
    if (theme.has(size)) {
      const value = theme.get(size)
      if (value !== undefined) addValue(value)
    } else if (fallback) {
      radii.push(fallback)
    }
  }

  for (const match of source.matchAll(
    /(?<![\w-])border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius['"]?\s*:\s*([^;{}<>\n]*)/gi,
  )) {
    addValue(match[1] ?? '')
  }
  for (const match of source.matchAll(
    /\bborder(?:Top|Bottom|Start|End)?(?:Left|Right|Start|End)?Radius\s*:\s*/g,
  )) {
    const start = match.index + match[0].length
    const number = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?![\w.])/.exec(source.slice(start, start + 32))
    if (number) {
      const radius = canonicalRadius(`${number[0]}px`)
      if (radius) radii.push(radius)
    } else {
      const literal = stringLiteralAt(source, start)
      if (literal !== undefined) addValue(literal)
    }
  }
  for (const match of source.matchAll(TAILWIND_ROUNDED)) {
    const size = match[1]!
    if (size.startsWith('[')) addValue(size.slice(1, -1).replaceAll('_', ' '))
    else addNamed(size, TAILWIND_RADII.get(size))
  }
  // A bare `rounded` is also an English word, so it only counts inside a class attribute.
  for (const match of source.matchAll(
    /(?<![\w-])(?::?class(?:Name)?)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\})/g,
  )) {
    const classes = match[1] ?? match[2] ?? match[3] ?? ''
    for (const token of classes.split(/\s+/)) {
      // Variants (md:, hover:, [&>*]:) end at the last colon; `!` marks important in v3 and v4.
      const utility = token.slice(token.lastIndexOf(':') + 1).replace(/^!|!$/g, '')
      if (BARE_ROUNDED.test(utility)) addNamed('DEFAULT', TAILWIND_DEFAULT_RADIUS)
    }
  }
  return radii
}

/** One canonical spelling per visible radius; zero, pill and token-driven values return undefined. */
function canonicalRadius(value: string): string | undefined {
  const text = value.trim().toLowerCase()
  if (!text || /var\(|\$|@|#\{|\$\{|^(?:inherit|initial|unset|revert|none|auto)$/.test(text)) {
    return undefined
  }
  const length = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|%|pt|vw|vh|vmin|vmax)?$/.exec(text)
  if (length) {
    const amount = Number(length[1])
    const unit = length[2] ?? 'px'
    if (!Number.isFinite(amount) || amount <= 0) return undefined
    const pixels =
      unit === 'px'
        ? amount
        : unit === 'rem' || unit === 'em'
          ? amount * 16
          : unit === 'pt'
            ? (amount * 4) / 3
            : undefined
    if (pixels !== undefined) {
      if (pixels >= 999) return undefined
      return `${Math.round(pixels * 2) / 2}px`
    }
    // Half the box or more is a circle or pill whatever the box size.
    if (amount >= 50) return undefined
    return `${amount}${unit}`
  }
  if (/^[a-z-]+\(.*\)$/.test(text)) return text.replace(/\s+/g, '')
  return undefined
}

function brandRadiusTokens(brand: BrandSystem | undefined): string[] | undefined {
  // designTokens is optional and owned by brand.json parsing elsewhere; read it defensively.
  const tokens = (brand as { designTokens?: unknown } | undefined)?.designTokens
  if (!tokens || typeof tokens !== 'object') return undefined
  const radius = (tokens as Record<string, unknown>).radius
  let values: unknown[] = []
  if (Array.isArray(radius)) values = radius
  else if (typeof radius === 'string') values = radius.split(/[\s,]+/)
  else if (radius && typeof radius === 'object') {
    const record = radius as Record<string, unknown>
    const scale = Array.isArray(record.scale)
      ? record.scale
      : Array.isArray(record.values)
        ? record.values
        : []
    values = [...scale, record.pill]
  }
  const canonical = values.flatMap((value) => {
    const radius =
      typeof value === 'number'
        ? canonicalRadius(`${value}px`)
        : typeof value === 'string'
          ? canonicalRadius(value)
          : undefined
    return radius ? [radius] : []
  })
  return canonical.length ? [...new Set(canonical)] : undefined
}

// ---- Small source readers -----------------------------------------------------------------

/** Whitespace-separated tokens outside quotes and parentheses. */
function topLevelTokens(value: string): string[] {
  const tokens: string[] = []
  let current = ''
  let depth = 0
  let quote: string | undefined
  for (const character of value) {
    if (quote) {
      current += character
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") {
      quote = character
      current += character
    } else if (character === '(') {
      depth += 1
      current += character
    } else if (character === ')') {
      depth = Math.max(0, depth - 1)
      current += character
    } else if (/\s/.test(character) && depth === 0) {
      if (current) tokens.push(current)
      current = ''
    } else {
      current += character
    }
  }
  if (current) tokens.push(current)
  return tokens
}

/** The contents of the string literal opening at `index`, or undefined. */
function stringLiteralAt(source: string, index: number): string | undefined {
  const quote = source[index]
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (cursor - index > MAX_LITERAL_LENGTH) return undefined
    const character = source[cursor]
    if (character === '\\') cursor += 1
    else if (character === quote) return source.slice(index + 1, cursor)
    else if (character === '\n' && quote !== '`') return undefined
  }
  return undefined
}

function firstStringLiteral(source: string): string | undefined {
  for (let index = 0; index < source.length; index += 1) {
    const literal = stringLiteralAt(source, index)
    if (literal !== undefined) return literal
  }
  return undefined
}

/** Index just past the bracket that closes the one at `index`. */
function balancedEnd(source: string, index: number): number | undefined {
  let depth = 0
  for (let cursor = index; cursor < source.length; cursor += 1) {
    if (cursor - index > MAX_BLOCK_LENGTH) return undefined
    const character = source[cursor]!
    if (character === '"' || character === "'" || character === '`') {
      const literal = stringLiteralAt(source, cursor)
      if (literal === undefined) return undefined
      cursor += literal.length + 1
    } else if ('{[('.includes(character)) {
      depth += 1
    } else if ('}])'.includes(character)) {
      depth -= 1
      if (depth === 0) return cursor + 1
    }
  }
  return undefined
}

/** Each top-level `key: value` entry in an object literal body, key as written. */
function topLevelEntries(body: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = []
  let depth = 0
  let entryStart = 0
  let valueStart: number | undefined
  for (let cursor = 0; cursor <= body.length; cursor += 1) {
    const character = body[cursor]
    if (character === '"' || character === "'" || character === '`') {
      const literal = stringLiteralAt(body, cursor)
      if (literal === undefined) break
      cursor += literal.length + 1
    } else if (character !== undefined && '{[('.includes(character)) {
      depth += 1
    } else if (character !== undefined && '}])'.includes(character)) {
      depth -= 1
    } else if (character === ':' && depth === 0 && valueStart === undefined) {
      valueStart = cursor + 1
    } else if ((character === ',' || character === undefined) && depth === 0) {
      if (valueStart !== undefined) {
        entries.push({
          key: body.slice(entryStart, valueStart - 1).trim(),
          value: body.slice(valueStart, cursor),
        })
      }
      entryStart = cursor + 1
      valueStart = undefined
    }
  }
  return entries
}
