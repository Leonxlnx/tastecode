import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DESIGN_KIT_DIRECTORY, writeDesignKitFile } from './artifact-store.js'
import { isDashboardBrief, type DesignBrief } from './brief.js'
import { array, list, optionalRecord, record, string, strings } from './parse.js'
import type { ReferenceDirection } from './reference-directions.js'

/**
 * Dashboards and app screens from the tasteskill v2.1 app library (app-screen-mode.ts).
 *
 * `references/app-screens/` holds unmodified copies of tasteskill's app library, its app-screen
 * chapter, `app.css`, `charts.js` and its license. This module ports the deal of tasteskill's
 * `draw.mjs --app` (a style, a shell and one pattern per screen), renders the dealt sheet for the
 * phase prompts, quotes the chapter's sections each phase needs, and writes the kit into the
 * workspace so every provider can copy it with ordinary file tools.
 */

const LIBRARY_ROOT = new URL('../references/app-screens/', import.meta.url)

/** Workspace-relative folder of the kit; the chapter's `<skill>/assets/...` paths mean this. */
export const APP_SCREEN_KIT_PATH = `.taste/${DESIGN_KIT_DIRECTORY}`

export interface AppStyle {
  id: string
  name: string
  theme: 'light' | 'dark'
  basis: string
  suits: string[]
  idea: string
  colourBudget?: string
  tokens: Record<string, unknown>
  font: AppStyleFont
  density: string
  shell: string
  shellAlternatives: string[]
  signature: string
  identity: string[]
  avoid: string[]
  notes?: string
}

interface AppStyleFont {
  family: string
  second?: string
  sizes: Record<string, number>
  weights: number[]
  note?: string
}

interface AppShell {
  id: string
  name: string
  numbers: Record<string, string | number>
  blueprint: string
  phone?: string
}

interface AppPattern {
  id: string
  name: string
  screen?: string
  kinds?: string[]
  blueprint: string
  phone?: string
  signature: boolean
  cues: string[]
}

interface AppLibrary {
  styles: AppStyle[]
  shells: AppShell[]
  patterns: AppPattern[]
  kinds: Map<string, { note: string; styles: string[]; screens: string[] }>
}

interface AppLibrarySource {
  version: string
  repository: string
  commit: string
  copyright: string
}

/** A dealt sheet, persisted with the run as library IDs so a resumed run renders the same sheet. */
export interface AppDirection {
  version: 1
  /** The library the IDs come from, such as "tasteskill v2.1.5". */
  source: string
  kind: string
  /** Only when the request names a light or dark interface. */
  theme?: 'light' | 'dark'
  style: string
  shell: string
  screens: Array<{ name: string; pattern?: string }>
  /** Signature elements whose words the request uses (a power flow for an energy home). */
  signatures: string[]
}

type AppBrief = Pick<DesignBrief, 'originalRequest'> &
  Partial<
    Pick<
      DesignBrief,
      | 'subject'
      | 'pageType'
      | 'offer'
      | 'primaryGoal'
      | 'audience'
      | 'requiredContent'
      | 'explicitAnswers'
    >
  >

let loaded: { library: AppLibrary; source: AppLibrarySource } | undefined

function bundle(): { library: AppLibrary; source: AppLibrarySource } {
  loaded ??= {
    library: parseAppLibrary(JSON.parse(appScreenFile('app.json'))),
    source: librarySource(),
  }
  return loaded
}

function appScreenFile(name: string): string {
  return readFileSync(new URL(name, LIBRARY_ROOT), 'utf8')
}

function librarySource(): AppLibrarySource {
  const provenance = record(JSON.parse(appScreenFile('provenance.json')), 'app-screen provenance')
  const source = record(provenance.source, 'app-screen provenance source')
  const copyright = /^Copyright .+$/mu.exec(appScreenFile('LICENSE'))?.[0]
  if (!copyright) throw new Error('app-screen LICENSE must name its copyright holder')
  return {
    version: string(source.version, 'app-screen provenance version'),
    repository: string(source.repository, 'app-screen provenance repository'),
    commit: string(source.commit, 'app-screen provenance commit'),
    copyright,
  }
}

/** "tasteskill v2.1.5": the library a sheet was dealt from. */
export function appScreenSource(): string {
  return `tasteskill v${bundle().source.version}`
}

function parseAppLibrary(value: unknown): AppLibrary {
  const library = record(value, 'app library')
  const styles = array(library.styles, 'app library styles').map((entry, index) => {
    const style = record(entry, `app style ${index}`)
    const id = string(style.id, `app style ${index} id`)
    const tokens = record(style.tokens, `${id}.tokens`)
    const font = record(tokens.font, `${id}.tokens.font`)
    const sizes = record(font.sizes, `${id}.tokens.font.sizes`)
    const theme = string(style.theme, `${id}.theme`)
    if (theme !== 'light' && theme !== 'dark') throw new Error(`${id}.theme must be light or dark`)
    return {
      id,
      name: string(style.name, `${id}.name`),
      theme,
      basis: string(style.basis, `${id}.basis`),
      suits: strings(style.suits, `${id}.suits`),
      idea: string(style.idea, `${id}.idea`),
      ...(typeof style.colourBudget === 'string' ? { colourBudget: style.colourBudget } : {}),
      tokens,
      font: {
        family: string(font.family, `${id}.tokens.font.family`),
        ...(typeof font.second === 'string' ? { second: font.second } : {}),
        sizes: Object.fromEntries(
          Object.entries(sizes).map(([role, size]) => {
            if (typeof size !== 'number')
              throw new Error(`${id} font size ${role} must be a number`)
            return [role, size]
          }),
        ),
        weights: list(font.weights, `${id}.tokens.font.weights`).map((weight) => {
          if (typeof weight !== 'number') throw new Error(`${id} font weights must be numbers`)
          return weight
        }),
        ...(typeof font.note === 'string' ? { note: font.note } : {}),
      },
      density: string(tokens.density, `${id}.tokens.density`),
      shell: string(style.shell, `${id}.shell`),
      shellAlternatives:
        style.shellAlternatives === undefined
          ? []
          : strings(style.shellAlternatives, `${id}.shellAlternatives`),
      signature: string(style.signature, `${id}.signature`),
      identity: style.identity === undefined ? [] : strings(style.identity, `${id}.identity`),
      avoid: style.avoid === undefined ? [] : strings(style.avoid, `${id}.avoid`),
      ...(typeof style.notes === 'string' ? { notes: style.notes } : {}),
    } satisfies AppStyle
  })
  const shells = array(library.shells, 'app library shells').map((entry, index) => {
    const shell = record(entry, `app shell ${index}`)
    const id = string(shell.id, `app shell ${index} id`)
    const numbers = optionalRecord(shell.numbers) ?? {}
    return {
      id,
      name: string(shell.name, `${id}.name`),
      numbers: Object.fromEntries(
        Object.entries(numbers).filter(
          (pair): pair is [string, string | number] =>
            typeof pair[1] === 'string' || typeof pair[1] === 'number',
        ),
      ),
      blueprint: string(shell.blueprint, `${id}.blueprint`),
      ...(typeof shell.phone === 'string' ? { phone: shell.phone } : {}),
    } satisfies AppShell
  })
  const patterns = array(library.patterns, 'app library patterns').map((entry, index) => {
    const pattern = record(entry, `app pattern ${index}`)
    const id = string(pattern.id, `app pattern ${index} id`)
    return {
      id,
      name: string(pattern.name, `${id}.name`),
      ...(typeof pattern.screen === 'string' ? { screen: pattern.screen } : {}),
      ...(pattern.kinds === undefined ? {} : { kinds: strings(pattern.kinds, `${id}.kinds`) }),
      blueprint: string(pattern.blueprint, `${id}.blueprint`),
      ...(typeof pattern.phone === 'string' ? { phone: pattern.phone } : {}),
      signature: pattern.signature === true,
      cues: pattern.cues === undefined ? [] : strings(pattern.cues, `${id}.cues`),
    } satisfies AppPattern
  })
  const kinds = new Map(
    Object.entries(record(library.kinds, 'app library kinds')).map(([kind, entry]) => {
      const value = record(entry, `app kind ${kind}`)
      return [
        kind,
        {
          note: string(value.note, `${kind}.note`),
          styles: strings(value.styles, `${kind}.styles`),
          screens: strings(value.screens, `${kind}.screens`),
        },
      ] as const
    }),
  )
  const styleIds = new Set(styles.map(({ id }) => id))
  const shellIds = new Set(shells.map(({ id }) => id))
  for (const style of styles) {
    for (const shell of [style.shell, ...style.shellAlternatives])
      if (!shellIds.has(shell)) throw new Error(`${style.id} names unknown shell ${shell}`)
  }
  for (const [kind, { styles: preferred }] of kinds) {
    for (const style of preferred)
      if (!styleIds.has(style)) throw new Error(`${kind} names unknown style ${style}`)
  }
  return { styles, shells, patterns, kinds }
}

/**
 * Words that place a request in one of the library's product kinds. tasteskill lets the agent
 * pass `--kind`; TasteCode deals before any phase runs, so it reads the kind from the brief.
 */
const KIND_WORDS = {
  finance: [
    'accounting',
    'bank',
    'banking',
    'bookkeeping',
    'budget',
    'budgeting',
    'buchhaltung',
    'cash flow',
    'cashflow',
    'expense',
    'expenses',
    'finance',
    'finances',
    'financial',
    'finanzen',
    'household',
    'invoice',
    'invoices',
    'invoicing',
    'ledger',
    'money',
    'payroll',
    'rechnungen',
    'savings',
    'spending',
    'tax',
  ],
  wallet: [
    'bitcoin',
    'crypto',
    'cryptocurrency',
    'ethereum',
    'personal finance',
    'send money',
    'stablecoin',
    'wallet',
    'wallets',
  ],
  commerce: [
    'bestellungen',
    'catalog',
    'catalogue',
    'checkout',
    'e-commerce',
    'ecommerce',
    'fulfillment',
    'fulfilment',
    'inventory',
    'merchant',
    'orders',
    'payout',
    'payouts',
    'product',
    'products',
    'seller',
    'shipping',
    'shop',
    'stock levels',
    'in stock',
    'store',
    'storefront',
  ],
  analytics: [
    'ads',
    'analytics',
    'attribution',
    'campaign',
    'campaigns',
    'cohort',
    'cohorts',
    'conversion',
    'conversions',
    'funnel',
    'growth',
    'insights',
    'kpi',
    'kpis',
    'marketing',
    'metrics',
    'pageviews',
    'retention',
    'seo',
    'traffic',
    'visitors',
  ],
  devtools: [
    'api',
    'apis',
    'build failed',
    'ci',
    'cluster',
    'database',
    'deploy',
    'deployment',
    'deployments',
    'deploys',
    'developer',
    'developers',
    'endpoint',
    'endpoints',
    'error rate',
    'incident',
    'incidents',
    'infrastructure',
    'kubernetes',
    'latency',
    'logs',
    'observability',
    'repository',
    'server',
    'servers',
    'uptime',
  ],
  builder: [
    'automation',
    'automations',
    'builder',
    'canvas',
    'editor',
    'flow builder',
    'form builder',
    'no-code',
    'nodes',
    'page builder',
    'pipeline',
    'workflow',
    'workflows',
  ],
  creator: [
    'audience',
    'channel',
    'creator',
    'creators',
    'newsletter',
    'newsletters',
    'podcast',
    'podcasts',
    'publication',
    'subscriber',
    'subscribers',
    'youtube',
  ],
  'smb-admin': [
    'admin',
    'agency',
    'appointments',
    'back office',
    'backoffice',
    'clients',
    'clinic',
    'crm',
    'customers',
    'kunden',
    'onboarding',
    'plans',
    'saas',
    'salon',
    'small business',
    'subscription',
    'subscriptions',
    'termine',
  ],
  workspace: [
    'aufgaben',
    'calendar',
    'docs',
    'notes',
    'personal',
    'planner',
    'projects',
    'projekte',
    'tasks',
    'team hub',
    'to-do',
    'todo',
    'wiki',
    'workspace',
  ],
  community: [
    'attendees',
    'club',
    'clubs',
    'community',
    'event',
    'events',
    'forum',
    'meetup',
    'meetups',
    'member',
    'members',
    'mitglieder',
    'rsvp',
    'rsvps',
    'veranstaltungen',
    'venue',
  ],
  support: [
    'conversations',
    'customer service',
    'help desk',
    'helpdesk',
    'inbox',
    'live chat',
    'queue',
    'sla',
    'slas',
    'support',
    'ticket',
    'tickets',
  ],
  markets: [
    'equities',
    'forex',
    'stock exchange',
    'markets',
    'order book',
    'portfolio',
    'quotes',
    'research',
    'securities',
    'stock market',
    'stocks',
    'trading',
    'watchlist',
  ],
  report: ['bericht', 'monthly report', 'report', 'reporting', 'reports', 'weekly report'],
} as const satisfies Record<string, readonly string[]>

/** A request without domain words gets one of the kinds that suit any operating screen. */
const GENERAL_KINDS = ['analytics', 'smb-admin', 'workspace'] as const

/** Screens a request may name beyond its kind's defaults, by tasteskill screen name. */
const SCREEN_WORDS = {
  settings: ['settings', 'billing', 'preferences', 'einstellungen'],
  inbox: ['inbox', 'queue'],
  analytics: ['analytics', 'reporting'],
  report: ['report'],
  wallet: ['wallet'],
  builder: ['builder', 'editor', 'canvas'],
  detail: ['detail page', 'detail view'],
} as const satisfies Record<string, readonly string[]>

function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '[\\s_-]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text)
}

function briefText(brief: AppBrief): string {
  return [
    brief.originalRequest,
    brief.subject,
    brief.pageType,
    brief.offer,
    brief.primaryGoal,
    brief.audience,
    ...(brief.requiredContent ?? []),
    ...(brief.explicitAnswers ?? []).map(({ answer }) => answer),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
}

/** The kinds whose words the request uses most, ties included; general kinds when none match. */
export function appScreenKinds(brief: AppBrief): string[] {
  const text = briefText(brief)
  const scores = Object.entries(KIND_WORDS).map(
    ([kind, words]) => [kind, words.filter((word) => containsWord(text, word)).length] as const,
  )
  const top = Math.max(...scores.map(([, score]) => score))
  return top > 0
    ? scores.filter(([, score]) => score === top).map(([kind]) => kind)
    : [...GENERAL_KINDS]
}

function requestedTheme(text: string): 'light' | 'dark' | undefined {
  const dark =
    /\bdark[\s-]+(?:mode|theme|ui|interface|design)\b|\bdunkel(?:modus|es design|er modus)\b/iu.test(
      text,
    )
  const light =
    /\blight[\s-]+(?:mode|theme|ui|interface|design)\b|\bhell(?:er modus|es design)\b/iu.test(text)
  return dark === light ? undefined : dark ? 'dark' : 'light'
}

function pick<T>(values: readonly T[], chooseIndex: (length: number) => number): T {
  const value = values[chooseIndex(values.length)]
  if (value === undefined) throw new Error('app-screen deal drew from an empty pool')
  return value
}

/** tasteskill's style pool: the theme first, then the styles that suit the kind when two do. */
function stylePool(library: AppLibrary, kind: string, theme?: 'light' | 'dark'): AppStyle[] {
  const preferred = library.kinds.get(kind)?.styles ?? []
  let pool = library.styles
  if (theme) {
    const themed = pool.filter((style) => style.theme === theme)
    if (themed.length) pool = themed
  }
  const fit = pool.filter((style) => preferred.includes(style.id) || style.suits.includes(kind))
  return fit.length >= 2 ? fit : pool
}

/** The style's own shell carries part of its move, so it is dealt about two times in three. */
function dealShell(
  library: AppLibrary,
  style: AppStyle,
  chooseIndex: (length: number) => number,
): AppShell {
  const own = library.shells.find(({ id }) => id === style.shell)!
  const alternatives = library.shells.filter(({ id }) => style.shellAlternatives.includes(id))
  if (!alternatives.length || chooseIndex(3) < 2) return own
  return pick(alternatives, chooseIndex)
}

function screenNames(library: AppLibrary, kind: string, text: string): string[] {
  const known = new Set(library.patterns.flatMap(({ screen }) => (screen ? [screen] : [])))
  const named = Object.entries(SCREEN_WORDS)
    .filter(
      ([screen, words]) => known.has(screen) && words.some((word) => containsWord(text, word)),
    )
    .map(([screen]) => screen)
  return [...new Set([...(library.kinds.get(kind)?.screens ?? ['overview']), ...named])]
}

/** tasteskill matches a signature cue at a word start, so "holiday" also finds "holidays". */
function signatureCue(text: string, cue: string): boolean {
  const escaped = cue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|[^a-z])${escaped}`, 'iu').test(text)
}

/**
 * Deal one sheet for a dashboard brief: a kind read from the brief, a style from that kind's
 * pool, the style's shell or an alternative, and one pattern for each screen. Unlike tasteskill
 * it keeps no per-user history of recent styles; every run draws uniformly.
 */
export function selectAppDirection(
  brief: AppBrief,
  chooseIndex: (length: number) => number = randomInt,
): AppDirection {
  const { library } = bundle()
  const text = briefText(brief)
  const kind = pick(appScreenKinds(brief), chooseIndex)
  const theme = requestedTheme(text)
  const style = pick(stylePool(library, kind, theme), chooseIndex)
  const shell = dealShell(library, style, chooseIndex)
  const screens = screenNames(library, kind, text).map((name) => {
    // A pattern written for another kind of product brings that product's furniture with it.
    const pool = library.patterns.filter(
      (pattern) => pattern.screen === name && (!pattern.kinds || pattern.kinds.includes(kind)),
    )
    return pool.length ? { name, pattern: pick(pool, chooseIndex).id } : { name }
  })
  const signatures = library.patterns
    .filter((pattern) => pattern.signature && pattern.cues.some((cue) => signatureCue(text, cue)))
    .map(({ id }) => id)
  return {
    version: 1,
    source: appScreenSource(),
    kind,
    ...(theme ? { theme } : {}),
    style: style.id,
    shell: shell.id,
    screens,
    signatures,
  }
}

/**
 * The sheet for a new run: a dashboard brief whose deck holds no dashboard reference image gets
 * one; a website, or a dashboard drawn from the parked image catalog, gets none.
 */
export function appDirectionForRun(
  brief: DesignBrief,
  deck: readonly ReferenceDirection[] = [],
  chooseIndex: (length: number) => number = randomInt,
): AppDirection | undefined {
  if (!isDashboardBrief(brief) || deck.some(({ family }) => family === 'dashboard'))
    return undefined
  return selectAppDirection(brief, chooseIndex)
}

export function parseAppDirection(value: unknown): AppDirection {
  const { library } = bundle()
  const direction = record(value, 'app direction')
  if (direction.version !== 1) throw new Error('app direction version must be 1')
  const kind = string(direction.kind, 'app direction kind')
  const style = string(direction.style, 'app direction style')
  const shell = string(direction.shell, 'app direction shell')
  const unknown = (what: string, id: string) =>
    new Error(
      `The saved app ${what} ${id} is not in the bundled tasteskill library. Restart Design mode.`,
    )
  if (!library.kinds.has(kind)) throw unknown('kind', kind)
  if (!library.styles.some(({ id }) => id === style)) throw unknown('style', style)
  if (!library.shells.some(({ id }) => id === shell)) throw unknown('shell', shell)
  const theme = direction.theme
  if (theme !== undefined && theme !== 'light' && theme !== 'dark')
    throw new Error('app direction theme must be light or dark')
  const screens = array(direction.screens, 'app direction screens').map((entry, index) => {
    const screen = record(entry, `app direction screens[${index}]`)
    const name = string(screen.name, `app direction screens[${index}].name`)
    if (screen.pattern === undefined) return { name }
    const pattern = string(screen.pattern, `app direction screens[${index}].pattern`)
    if (!library.patterns.some(({ id, screen }) => id === pattern && screen === name))
      throw unknown('screen pattern', pattern)
    return { name, pattern }
  })
  const signatures = strings(direction.signatures ?? [], 'app direction signatures')
  for (const signature of signatures)
    if (!library.patterns.some(({ id, signature: isSignature }) => id === signature && isSignature))
      throw unknown('signature element', signature)
  return {
    version: 1,
    source: string(direction.source, 'app direction source'),
    kind,
    ...(theme ? { theme } : {}),
    style,
    shell,
    screens,
    signatures,
  }
}

/** The dealt style, for the typeface checks and the Brand mapping. */
export function appDirectionStyle(direction: AppDirection): AppStyle {
  const style = bundle().library.styles.find(({ id }) => id === direction.style)
  if (!style) throw new Error(`Unknown app style ${direction.style}`)
  return style
}

/** The style's interface family and, when it has one, its second face's family. */
export function appDirectionTypefaces(direction: AppDirection): string[] {
  const { font } = appDirectionStyle(direction)
  const second = font.second?.split(',')[0]?.trim()
  return second ? [font.family, second] : [font.family]
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)
}

/** The style's tokens as CSS custom properties, named as `app.css` and the chapter name them. */
export function appDirectionTokens(direction: AppDirection) {
  const { tokens, font } = appDirectionStyle(direction)
  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries(tokens)) {
    if (key === 'font' || key === 'density') continue
    if (typeof value === 'string') variables[`--${kebab(key)}`] = value
    else if (typeof value === 'number') variables[`--${kebab(key)}`] = `${value}px`
    else if (key === 'chart' && Array.isArray(value))
      value.forEach((colour, index) => (variables[`--chart-${index + 1}`] = String(colour)))
    else if (key === 'pills' && optionalRecord(value))
      for (const [name, pair] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        variables[`--pill-${name}-bg`] = String(pair[0])
        variables[`--pill-${name}-ink`] = String(pair[1])
      }
    else if (key === 'radius' && optionalRecord(value))
      for (const [name, radius] of Object.entries(value as Record<string, unknown>))
        variables[`--radius-${name}`] = `${String(radius)}px`
  }
  for (const [role, size] of Object.entries(font.sizes)) variables[`--fs-${role}`] = `${size}px`
  return variables
}

/**
 * The dealt sheet as the phases read it, adapted from tasteskill's printed app sheet: TasteCode
 * dealt it, it cannot be redrawn mid-run, the font comes from the Assets phase instead of a
 * Google Fonts link, and the fallback stack is generic so the brand font audit stays meaningful.
 */
export function appSheetGuidance(direction: AppDirection): string {
  const { library } = bundle()
  const style = appDirectionStyle(direction)
  const shell = library.shells.find(({ id }) => id === direction.shell)!
  const lines: string[] = []
  const line = (text = '') => lines.push(text)
  line(
    `APP SHEET: dealt by TasteCode from ${direction.source} for this run (product kind ${direction.kind}: ${library.kinds.get(direction.kind)?.note ?? direction.kind}${direction.theme ? `; the request names a ${direction.theme} interface` : ''}).`,
  )
  line(
    "This is the style for this product and it is fixed for this run: no phase redraws it. Adopt it whole and keep its move intact; everything the sheet does not fix comes from the shared defaults in the app-screen rules. The values were measured on real product screens: use them as given rather than rounding them towards your habits. An explicit user requirement, an attached user reference or an existing brand outranks the sheet's colours and typeface: map that brand's colours onto the roles below and keep the style's colour budget, sizes, radii, row and control heights.",
  )
  line()
  line(`1. The style: ${style.name} (${style.id}, ${style.theme})`)
  line(style.idea)
  line(`The move: ${style.signature}`)
  if (style.colourBudget) line(`Colour budget: ${style.colourBudget}.`)
  if (style.avoid.length) line(`Off-style here: ${style.avoid.join('; ')}.`)
  line(`Distilled from ${style.basis}.${style.notes ? ` ${style.notes}` : ''}`)
  if (style.identity.length) {
    line()
    line(
      "Its face. Choose one of these (or one of your own of the same weight) before you build, write it next to the screen's question, and make sure it shows on the first screen. Without one the screen reads as a well-applied kit.",
    )
    for (const face of style.identity) line(`- ${face}`)
  }
  const signatures = direction.signatures.flatMap((id) => {
    const pattern = library.patterns.find((entry) => entry.id === id)
    return pattern ? [pattern] : []
  })
  if (signatures.length) {
    line()
    line(
      'Signature elements this brief names (an element only this kind of product has; build one of them as part of a screen):',
    )
    for (const pattern of signatures)
      line(
        `- ${pattern.name} (${pattern.id}). ${pattern.blueprint}${pattern.phone ? ` On a phone: ${pattern.phone}` : ''}`,
      )
  }
  line()
  line('2. Tokens')
  line(':root {')
  for (const [name, value] of Object.entries(appDirectionTokens(direction)))
    line(`  ${name}: ${value};`)
  line('}')
  line(
    `Density: ${style.density}. One gap value, horizontally and vertically. ${typeof style.tokens.shadow === 'string' ? "The shadow belongs to this dark style's cards only; nothing else casts one." : 'No shadow on anything at rest.'}`,
  )
  line()
  const { font } = style
  const second = font.second?.split(',')[0]?.trim()
  line(`3. Type: ${font.family}`)
  line(
    `font-family: "${font.family}", system-ui, sans-serif. Weights ${font.weights.join(', ')}. Sizes: ${Object.entries(
      font.sizes,
    )
      .map(([role, size]) => `${role} ${size}px`)
      .join(
        ' · ',
      )}.${font.note ? ` ${font.note}` : ''}${font.second ? ` Second face: ${font.second}${second && /mono/iu.test(second) ? ` (font-family: "${second}", monospace)` : ''}.` : ''}`,
  )
  line(
    `Every face is free on Google Fonts; the Assets phase acquires the files and Build loads them. Numbers: font-variant-numeric: tabular-nums on every table, KPI and anything that updates. Sentence case; no tracked capitals.`,
  )
  line()
  line(`4. Shell: ${shell.name} (${shell.id})`)
  line(shell.blueprint)
  const numbers = Object.entries(shell.numbers)
  if (numbers.length)
    line(`Numbers: ${numbers.map(([key, value]) => `${key} ${value}`).join('; ')}.`)
  if (shell.phone) line(`On a phone: ${shell.phone}`)
  line()
  line('5. Screens')
  for (const screen of direction.screens) {
    const pattern = screen.pattern
      ? library.patterns.find(({ id }) => id === screen.pattern)
      : undefined
    line(
      pattern
        ? `- ${screen.name}: ${pattern.name} (${pattern.id}). ${pattern.blueprint}${pattern.phone ? ` On a phone: ${pattern.phone}` : ''}`
        : `- ${screen.name}: no pattern in the library suits this kind of product; compose it from the app-screen rules.`,
    )
  }
  line()
  line('6. Always')
  line(
    `Real data for this product, written before the markup: names, amounts that add up, dates in order, units on every figure, honest zeros and dashes. One chart answers one question. No gradients, glows, glass, icons in tinted squares, sparklines on KPIs, rainbow charts, emoji, lorem or Acme. ${APP_SCREEN_KIT_PATH}/app.css and ${APP_SCREEN_KIT_PATH}/charts.js are a neutral start set to these rules.`,
  )
  return lines.join('\n')
}

interface ChapterSection {
  id: string
  text: string
}

let chapter: ChapterSection[] | undefined

/**
 * The chapter split at its headings: "intro" before the contents, "N" for each `## N.` part
 * (its `###` subsections included), "N.M" for each numbered subsection.
 */
function chapterSections(): ChapterSection[] {
  if (chapter) return chapter
  const text = appScreenFile('app-screens.md')
  const parts = text.split(/^(?=## )/mu)
  const sections: ChapterSection[] = [{ id: 'intro', text: parts[0]! }]
  for (const part of parts.slice(1)) {
    const id = /^## (\d+)\./u.exec(part)?.[1] ?? /^## (.+)$/mu.exec(part)![1]!.trim().toLowerCase()
    sections.push({ id, text: part })
    for (const subsection of part.split(/^(?=### )/mu).slice(1)) {
      const subId = /^### (\d+\.\d+) /u.exec(subsection)?.[1]
      if (subId) sections.push({ id: subId, text: subsection })
    }
  }
  chapter = sections
  return sections
}

const CHAPTER_NOTE = `The text below is quoted unchanged from tasteskill's app-screen chapter (references/app-screens.md, MIT). Read it as written, with three adaptations: TasteCode already dealt the sheet that \`draw.mjs --app\` would print (above), so never run or redraw it; TasteCode does not run tasteskill's \`lint.mjs\` or \`inspect.mjs\`, so verify every rule the chapter says they check yourself, in the browser where it is visual, and TasteCode's preview capture, DOM audit and visual Review follow Build; \`<skill>/assets/app.css\`, \`assets/charts.js\`, \`app.css\` and \`Charts.*\` mean the copies TasteCode placed in ${APP_SCREEN_KIT_PATH}/. Section numbers (§) refer to this chapter; the whole chapter is at ${APP_SCREEN_KIT_PATH}/app-screens.md.`

/** Quotes the named chapter sections in document order, without repeating a nested one. */
export function appScreenRules(ids: readonly string[]): string {
  const sections = chapterSections()
  for (const id of ids)
    if (!sections.some((section) => section.id === id))
      throw new Error(`app-screen chapter has no section ${id}`)
  const wanted = new Set(ids)
  const quoted = sections.filter(
    ({ id }) => wanted.has(id) && !(id.includes('.') && wanted.has(id.split('.')[0]!)),
  )
  return `TASTESKILL APP-SCREEN RULES (${appScreenSource()}):
${CHAPTER_NOTE}

<tasteskill-app-screen-rules>
${quoted.map(({ text }) => text.trimEnd()).join('\n\n')}
</tasteskill-app-screen-rules>`
}

/**
 * Writes the kit to `.taste/app-kit/`: `app.css` and `charts.js` with a license line that copies
 * keep, the whole chapter, and the license. It is rewritten on every call, so a phase always
 * finds the bundled version.
 */
export function writeAppScreenKit(workspacePath: string): void {
  const { source } = bundle()
  const header = (file: string) =>
    `/* tasteskill v${source.version} ${file} (MIT License, ${source.copyright}): ${source.repository}. Keep this line in every copy. */\n`
  writeDesignKitFile(workspacePath, 'app.css', header('app.css') + appScreenFile('app.css'))
  writeDesignKitFile(workspacePath, 'charts.js', header('charts.js') + appScreenFile('charts.js'))
  writeDesignKitFile(workspacePath, 'app-screens.md', appScreenFile('app-screens.md'))
  writeDesignKitFile(workspacePath, 'LICENSE', appScreenFile('LICENSE'))
}
