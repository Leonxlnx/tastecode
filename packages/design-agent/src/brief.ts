import { readDesignArtifact, writeDesignArtifact } from './artifact-store.js'
import { record, string, stringsAllowEmpty } from './parse.js'

export interface ExplicitBriefAnswer {
  question: string
  answer: string
}

export interface DesignBrief {
  originalRequest: string
  subject: string
  pageType: string
  scope: string
  primaryGoal: string
  audience: string
  offer: string
  primaryAction: string
  requiredContent: string[]
  constraints: string[]
  brandInputs: string[]
  creativeControl: string
  explicitAnswers: ExplicitBriefAnswer[]
  assumptions: string[]
  unresolved: string[]
}

/** Words that name a marketing surface: a site or page about a product rather than the product. */
const MARKETING_SURFACE =
  /\b(?:landing ?(?:pages?)?|launch ?pages?|marketing|portfolio|(?:web|micro)? ?sites?|(?:web|start|internet)? ?seiten?|webauftritt|home ?pages?|web ?pages?|one ?pagers?)\b/u
/** Pages of a product's website rather than views of the product ("pricing page"). */
const MARKETING_PAGE_NAMES =
  'pricing|about(?: us)?|wait ?list|careers?|blog|contact(?: us)?|features?|changelog'
/** A page type naming one of those pages; page types are labels, not prose. */
const MARKETING_PAGE_TYPE = new RegExp(`\\b(?:${MARKETING_PAGE_NAMES}) ?pages?\\b`, 'u')
/**
 * A standalone page that presents a product ("a page for our analytics app", "a pricing page
 * for our app") rather than operating it. "Settings page for the admin app" names an app view
 * and stays a dashboard.
 */
const PAGE_ABOUT_PRODUCT = new RegExp(
  `\\b(?:a|one|single|simple|marketing|product|promo|promotional|${MARKETING_PAGE_NAMES})\\s+page\\s+(?:about|for|showcasing|promoting|presenting|introducing)\\b`,
  'u',
)
const APPLICATION_SURFACE =
  /\b(?:dashboards?|admin|analytics|applications?|apps?|webapps?|product interface)\b/u

export function isDashboardBrief(
  brief: Pick<DesignBrief, 'pageType' | 'originalRequest'>,
): boolean {
  // The requested surface wins over the product being advertised on it: a site,
  // one-pager or Webseite for an analytics app is still a website.
  const pageType = surfaceText(brief.pageType)
  if (isMarketingSurface(pageType) || MARKETING_PAGE_TYPE.test(pageType)) return false
  if (APPLICATION_SURFACE.test(pageType)) return true
  const request = surfaceText(brief.originalRequest)
  return !isMarketingSurface(request) && APPLICATION_SURFACE.test(request)
}

function isMarketingSurface(text: string): boolean {
  return MARKETING_SURFACE.test(text) || PAGE_ABOUT_PRODUCT.test(text)
}

function surfaceText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[_-]/gu, ' ')
}

const STRING_FIELDS = [
  'originalRequest',
  'subject',
  'pageType',
  'scope',
  'primaryGoal',
  'audience',
  'offer',
  'primaryAction',
  'creativeControl',
] as const

const STRING_ARRAY_FIELDS = [
  'requiredContent',
  'constraints',
  'brandInputs',
  'assumptions',
  'unresolved',
] as const

export function parseDesignBrief(value: unknown): DesignBrief {
  const brief = record(value, 'design brief')
  for (const field of STRING_FIELDS) {
    string(brief[field], `design brief field ${field}`)
  }
  for (const field of STRING_ARRAY_FIELDS) {
    stringsAllowEmpty(brief[field], `design brief field ${field}`)
  }
  if (
    !Array.isArray(brief.explicitAnswers) ||
    !brief.explicitAnswers.every(isExplicitBriefAnswer)
  ) {
    throw new Error('design brief field explicitAnswers must contain question and answer strings')
  }
  // Rebuilt field-by-field like every other parser in this package: the raw
  // cast kept arbitrary model-authored extra keys, which were persisted and
  // re-serialized verbatim into the Build agent's instruction block.
  return {
    originalRequest: string(brief.originalRequest, 'design brief field originalRequest'),
    subject: string(brief.subject, 'design brief field subject'),
    pageType: string(brief.pageType, 'design brief field pageType'),
    scope: string(brief.scope, 'design brief field scope'),
    primaryGoal: string(brief.primaryGoal, 'design brief field primaryGoal'),
    audience: string(brief.audience, 'design brief field audience'),
    offer: string(brief.offer, 'design brief field offer'),
    primaryAction: string(brief.primaryAction, 'design brief field primaryAction'),
    creativeControl: string(brief.creativeControl, 'design brief field creativeControl'),
    requiredContent: stringsAllowEmpty(brief.requiredContent, 'design brief field requiredContent'),
    constraints: stringsAllowEmpty(brief.constraints, 'design brief field constraints'),
    brandInputs: stringsAllowEmpty(brief.brandInputs, 'design brief field brandInputs'),
    assumptions: stringsAllowEmpty(brief.assumptions, 'design brief field assumptions'),
    unresolved: stringsAllowEmpty(brief.unresolved, 'design brief field unresolved'),
    explicitAnswers: brief.explicitAnswers.map((item) => ({
      question: item.question,
      answer: item.answer,
    })),
  }
}

function isExplicitBriefAnswer(value: unknown): value is ExplicitBriefAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'question' in value &&
    typeof value.question === 'string' &&
    'answer' in value &&
    typeof value.answer === 'string'
  )
}

export function readDesignBrief(workspacePath: string): DesignBrief {
  return parseDesignBrief(readDesignArtifact(workspacePath, 'brief.json'))
}

export function writeDesignBrief(workspacePath: string, value: unknown): DesignBrief {
  const brief = parseDesignBrief(value)
  writeDesignArtifact(workspacePath, 'brief.json', brief)
  return brief
}
