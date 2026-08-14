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

const CLAIM_PATTERNS = [
  /[$€£]\s?\d|\b\d[\d,.]*\s?(?:USD|EUR|GBP)\b/iu,
  /\b\d+(?:[.,]\d+)?\s*(?:%|x|×)(?![\p{L}\p{N}_])/iu,
  /\b\d[\d,.]*\+?\s+(?:customers?|users?|teams?|companies|countries|years?|hours?|minutes?|days?|projects?|reviews?|downloads?|orders?)\b/iu,
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

const GENERIC_EYEBROWS = new Set([
  'about',
  'overview',
  'features',
  'services',
  'solutions',
  'benefits',
  'why us',
  'what we do',
  'our work',
  'introducing',
  'discover',
  'welcome',
  'experience',
  'innovation',
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

const SEQUENCE_SIGNAL =
  /\b(?:step|phase|stage|process|sequence|timeline|chapter|part|lesson|method|how it works)\b/iu

export function lintPageCopy(page: PageBlueprint): CopyLintFinding[] {
  const surfaces = collectCopy(page)
  const findings = [
    ...lintEmDashes(surfaces),
    ...lintClaims(surfaces),
    ...lintCliches(surfaces),
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
    if (!CLAIM_PATTERNS.some((pattern) => pattern.test(surface.text))) return []
    return [
      finding(
        'copy/objective-claim',
        surface.evidence.length ? 'review' : 'error',
        surface,
        surface.evidence.length
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
  const eyebrows = page.sections.flatMap((section, index) =>
    section.copy.eyebrow ? [{ section, index, text: section.copy.eyebrow }] : [],
  )
  const findings = eyebrows.flatMap(({ index, text }) => {
    const normalized = normalize(text)
    const path = `sections[${index}].copy.eyebrow`
    const result: CopyLintFinding[] = []
    if (
      GENERIC_EYEBROWS.has(normalized) ||
      (text === text.toUpperCase() && /[A-Z]{2}/u.test(text))
    ) {
      result.push({
        rule: 'copy/decorative-eyebrow',
        severity: 'warning',
        path,
        excerpt: text,
        message:
          'Omit the eyebrow unless it adds real taxonomy, status, provenance, or orientation.',
      })
    }
    return result
  })
  if (eyebrows.length >= 3 && eyebrows.length * 2 >= page.sections.length) {
    findings.push({
      rule: 'copy/eyebrow-overuse',
      severity: 'warning',
      path: 'sections',
      excerpt: `${eyebrows.length} of ${page.sections.length} sections`,
      message: 'Reserve eyebrows for the rare sections that need extra orientation.',
    })
  }

  const numbered = eyebrows.filter(({ text }) => /^0?(\d{1,2})(?:[.:/-])?$/u.test(text))
  const values = numbered.map(({ text }) => Number(/\d+/u.exec(text)?.[0])).sort((a, b) => a - b)
  const consecutive =
    values.length >= 3 && values.every((value, index) => !index || value === values[index - 1]! + 1)
  const hasSequenceMeaning = numbered.every(({ section }) =>
    SEQUENCE_SIGNAL.test(`${section.purpose} ${section.userQuestion} ${section.copy.heading}`),
  )
  if (consecutive && !hasSequenceMeaning) {
    findings.push({
      rule: 'copy/decorative-numbering',
      severity: 'warning',
      path: 'sections',
      excerpt: numbered.map(({ text }) => text).join(' / '),
      message: 'Use section numbers only when they encode a real sequence or stable reference.',
    })
  }
  return findings
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
