import type { PageBlueprint } from './page.js'

export type CopyLintSeverity = 'error' | 'warning' | 'review'

export interface CopyLintFinding {
  rule: string
  severity: CopyLintSeverity
  path: string
  excerpt: string
  message: string
}

interface CopySurface {
  path: string
  text: string
  evidence: string[]
}

const NUMERIC_CLAIM_PATTERNS = [
  /[$€£]\s?\d|\b\d[\d,.]*\s?(?:USD|EUR|GBP)\b/iu,
  /\b\d+(?:[.,]\d+)?\s*(?:%|x|×)(?![\p{L}\p{N}_])/iu,
  /\b\d[\d,.]*\+?\s+(?:customers?|users?|teams?|companies|countries|years?|hours?|minutes?|days?|projects?|reviews?|downloads?|orders?)\b/iu,
]

const CLAIM_PATTERNS = [
  /\b(?:save[sd]?|saving|cuts?|reduce[sd]?|increase[sd]?|boost[sd]?|improve[sd]?)\b[^.!?]{0,60}\b\d/iu,
  /\b\d+(?:[.,]\d+)?\s*(?:%|x|×)\s+(?:faster|cheaper|more|less|accurate|accuracy|uptime|reliability|savings)\b/iu,
  /\b(?:fastest|safest|cheapest|most trusted|most accurate|most reliable|highest[- ]rated|lowest[- ]cost|#\s*1|number one|the only)\b/iu,
  /\b(?:studies show|research (?:shows|proves)|clinically proven|doctors recommend|award[- ]winning|trusted by|used by)\b/iu,
  /\b(?:today only|limited spots?|ends soon|act now)\b/iu,
]

const CLICHE_PATTERNS: Array<[number, RegExp]> = [
  [3, /\bthe future of\b/iu],
  [3, /\bwhere\b[^.!?]{1,48}\bmeets\b/iu],
  [3, /,\s*(?:reimagined|redefined)\b/iu],
  [3, /\bone (?:platform|place)\b[^.!?]{0,48}\b(?:everything|endless)\b/iu],
  [3, /\bin today'?s (?:fast-paced|ever-changing|digital) world\b/iu],
  [3, /\bno\b[^.!?]{1,30}\.\s*no\b[^.!?]{1,30}\.\s*just\b/iu],
  [2, /\b(?:seamless(?:ly)?|effortless(?:ly)?)\b/iu],
  [2, /\bunlock\b[^.!?]{0,35}\b(?:power|potential|possibilities)\b/iu],
  [2, /\belevate your\b/iu],
  [2, /\btransform the way\b/iu],
  [2, /\b(?:built|designed) for modern teams\b/iu],
  [2, /\b(?:all-in-one|everything you need|endless possibilities)\b/iu],
  [2, /\b(?:next[- ]generation|cutting[- ]edge|game[- ]changing)\b/iu],
  [2, /\b(?:world[- ]class|best[- ]in[- ]class|industry[- ]leading)\b/iu],
]

const GENERIC_CTAS = new Set([
  'click here',
  'here',
  'learn more',
  'read more',
  'discover',
  'discover more',
  'explore',
  'find out more',
  'see how',
  'take the next step',
  'start your journey',
  'experience the difference',
  'join the revolution',
])

const SATURATED_NAMES = new Set([
  'apex',
  'beacon',
  'canvas',
  'echo',
  'flow',
  'forge',
  'helix',
  'loom',
  'lumen',
  'nexus',
  'nova',
  'orbit',
  'prism',
  'pulse',
  'relay',
  'signal',
  'spark',
  'summit',
  'vector',
])

const PLACEHOLDER_PATTERNS = [
  /\b(?:to be supplied|awaiting approval|none supplied|live data required|property data required|operating dates required)\b/iu,
  /\b(?:sample data|test data|model data|simulated data|not a live sensor|not connected)\b/iu,
  /\b(?:local preview|nothing leaves this page|do not publish|before launch|still needed)\b/iu,
  /\bthis prototype\b/iu,
]

const MAX_HEADING_WORDS = 12
const MAX_HEADING_CHARACTERS = 72

export function lintPageCopy(page: PageBlueprint): CopyLintFinding[] {
  const surfaces = collectCopy(page)
  const findings = [
    ...lintEmDashes(surfaces),
    ...lintClaims(surfaces),
    ...lintCliches(surfaces),
    ...lintPlaceholders(surfaces),
    ...lintHeadings(page),
    ...lintHeroCopyStack(page),
    ...lintCallsToAction(page),
    ...lintEyebrows(page),
    ...lintProductName(page),
  ]
  return findings.sort(
    (left, right) => left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule),
  )
}

export function assertPageCopy(page: PageBlueprint): PageBlueprint {
  const errors = lintPageCopy(page).filter(({ severity }) => severity === 'error')
  if (errors.length) {
    throw new Error(
      `page copy failed: ${errors.map(({ rule, path }) => `${rule} at ${path}`).join('; ')}`,
    )
  }
  return page
}

function collectCopy(page: PageBlueprint): CopySurface[] {
  const pageEvidence = page.sections.flatMap(({ evidence }) => evidence)
  return [
    { path: 'page.title', text: page.page.title, evidence: pageEvidence },
    { path: 'page.description', text: page.page.description, evidence: pageEvidence },
    ...page.navigation.map(({ label }, index) => ({
      path: `navigation[${index}].label`,
      text: label,
      evidence: pageEvidence,
    })),
    ...page.sections.flatMap((section, sectionIndex) => [
      ...(section.copy.eyebrow
        ? [
            {
              path: `sections[${sectionIndex}].copy.eyebrow`,
              text: section.copy.eyebrow,
              evidence: section.evidence,
            },
          ]
        : []),
      {
        path: `sections[${sectionIndex}].copy.heading`,
        text: section.copy.heading,
        evidence: section.evidence,
      },
      ...section.copy.body.map((text, bodyIndex) => ({
        path: `sections[${sectionIndex}].copy.body[${bodyIndex}]`,
        text,
        evidence: section.evidence,
      })),
      ...section.copy.callsToAction.map(({ label }, actionIndex) => ({
        path: `sections[${sectionIndex}].copy.callsToAction[${actionIndex}].label`,
        text: label,
        evidence: section.evidence,
      })),
    ]),
  ]
}

function lintEmDashes(surfaces: CopySurface[]): CopyLintFinding[] {
  return surfaces
    .filter(({ text }) => text.includes('\u2014'))
    .map((surface) => finding('copy/em-dash', 'error', surface, 'Replace the em dash.'))
}

function lintClaims(surfaces: CopySurface[]): CopyLintFinding[] {
  return surfaces.flatMap((surface) => {
    const assertedClaim = CLAIM_PATTERNS.some((pattern) => pattern.test(surface.text))
    if (!assertedClaim && !NUMERIC_CLAIM_PATTERNS.some((pattern) => pattern.test(surface.text)))
      return []
    // Numeric terms in visibly fictional examples are content, not product proof.
    // Keep assertions such as "trusted by" subject to the evidence requirement.
    const illustrativeValue =
      !assertedClaim && /\b(?:fictional|illustrative|representative)\b/iu.test(surface.text)
    return [
      finding(
        'copy/objective-claim',
        surface.evidence.length || illustrativeValue ? 'review' : 'error',
        surface,
        illustrativeValue
          ? 'Keep the illustrative context visible and verify the example values before publishing.'
          : surface.evidence.length
            ? 'Verify the claim against its recorded evidence before publishing.'
            : 'Remove the objective claim or attach real evidence to the section.',
      ),
    ]
  })
}

function lintCliches(surfaces: CopySurface[]): CopyLintFinding[] {
  return surfaces.flatMap((surface) => {
    const score = CLICHE_PATTERNS.reduce(
      (total, [weight, pattern]) => total + (pattern.test(surface.text) ? weight : 0),
      0,
    )
    return score < 3
      ? []
      : [
          finding(
            'copy/generic-phrase',
            'warning',
            surface,
            'Replace the formula with a concrete actor, action, object, or verified boundary.',
          ),
        ]
  })
}

function lintPlaceholders(surfaces: CopySurface[]): CopyLintFinding[] {
  return surfaces
    .filter(({ text }) => PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text)))
    .map((surface) =>
      finding(
        'copy/internal-placeholder',
        'error',
        surface,
        'Replace internal status or prototype copy with finished user-facing content.',
      ),
    )
}

function lintHeadings(page: PageBlueprint): CopyLintFinding[] {
  return page.sections.flatMap((section, index) => {
    const heading = section.copy.heading.trim()
    const wordCount = heading.split(/\s+/u).length
    if (
      section.referenceDirectionId ||
      (wordCount <= MAX_HEADING_WORDS && heading.length <= MAX_HEADING_CHARACTERS)
    )
      return []
    return [
      {
        rule: 'copy/heading-length',
        severity: 'error' as const,
        path: `sections[${index}].copy.heading`,
        excerpt: heading,
        message: `Keep headings within ${MAX_HEADING_WORDS} words and ${MAX_HEADING_CHARACTERS} characters so they fit one or two lines; three lines is a rare visual exception.`,
      },
    ]
  })
}

function lintHeroCopyStack(page: PageBlueprint): CopyLintFinding[] {
  return page.sections.flatMap((section, index) =>
    section.layoutFamily === 'hero' && section.copy.body.length > 1
      ? [
          {
            rule: 'copy/hero-body-stack',
            severity: 'error' as const,
            path: `sections[${index}].copy.body`,
            excerpt: `${section.copy.body.length} supporting blocks`,
            message: 'Use at most one concise supporting block in the Hero.',
          },
        ]
      : [],
  )
}

function lintCallsToAction(page: PageBlueprint): CopyLintFinding[] {
  const actions = page.sections.flatMap((section, sectionIndex) =>
    section.copy.callsToAction.map((action, actionIndex) => ({
      ...action,
      path: `sections[${sectionIndex}].copy.callsToAction[${actionIndex}].label`,
      normalizedLabel: normalize(action.label),
    })),
  )
  const findings = actions.flatMap((action) =>
    GENERIC_CTAS.has(action.normalizedLabel)
      ? [
          finding(
            'copy/generic-cta',
            action.normalizedLabel === 'click here' || action.normalizedLabel === 'here'
              ? 'error'
              : 'warning',
            { path: action.path, text: action.label, evidence: [] },
            'Name the action or destination directly.',
          ),
        ]
      : [],
  )
  const labelsByTarget = new Map<string, Set<string>>()
  for (const action of actions) {
    const labels = labelsByTarget.get(action.target) ?? new Set<string>()
    labels.add(action.normalizedLabel)
    labelsByTarget.set(action.target, labels)
  }
  for (const [target, labels] of labelsByTarget) {
    if (labels.size < 2) continue
    findings.push({
      rule: 'copy/cta-label-drift',
      severity: 'warning',
      path: `target:${target}`,
      excerpt: [...labels].join(' / '),
      message: 'Use one label for one action intent.',
    })
  }
  return findings
}

function lintEyebrows(page: PageBlueprint): CopyLintFinding[] {
  return page.sections.flatMap((section, index) => {
    if (!('eyebrow' in section.copy) || typeof section.copy.eyebrow !== 'string') return []
    const eyebrow = section.copy.eyebrow.trim()
    if (!eyebrow || section.referenceDirectionId) return []
    return [
      {
        rule: 'copy/decorative-eyebrow',
        severity: 'error' as const,
        path: `sections[${index}].copy.eyebrow`,
        excerpt: eyebrow,
        message: 'Remove the eyebrow and express necessary context in the heading or body.',
      },
    ]
  })
}

function lintProductName(page: PageBlueprint): CopyLintFinding[] {
  const normalized = normalize(page.page.title).replaceAll(/[^a-z0-9 ]/gu, '')
  const tokens = normalized.split(' ').filter(Boolean)
  const descriptors = new Set([
    'ai',
    'app',
    'cloud',
    'hq',
    'labs',
    'platform',
    'studio',
    'systems',
    'tech',
  ])
  const saturated = tokens.filter((token) => SATURATED_NAMES.has(token))
  if (
    !SATURATED_NAMES.has(normalized) &&
    !(saturated.length && tokens.some((token) => descriptors.has(token)))
  ) {
    return []
  }
  return [
    {
      rule: 'copy/saturated-product-name',
      severity: 'review',
      path: 'page.title',
      excerpt: page.page.title,
      message:
        'Preserve a user-owned name, but preliminarily screen generated names for collisions.',
    },
  ]
}

function finding(
  rule: string,
  severity: CopyLintSeverity,
  surface: CopySurface,
  message: string,
): CopyLintFinding {
  return { rule, severity, path: surface.path, excerpt: surface.text, message }
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('’', "'")
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}
