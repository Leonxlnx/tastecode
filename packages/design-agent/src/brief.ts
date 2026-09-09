import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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

function parseDesignBrief(value: unknown): DesignBrief {
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

function briefPath(workspacePath: string): string {
  return path.join(workspacePath, '.taste', 'brief.json')
}

export function readDesignBrief(workspacePath: string): DesignBrief {
  return parseDesignBrief(JSON.parse(readFileSync(briefPath(workspacePath), 'utf8')))
}

export function writeDesignBrief(workspacePath: string, value: unknown): DesignBrief {
  const brief = parseDesignBrief(value)
  const outputPath = briefPath(workspacePath)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(brief, null, 2)}\n`, 'utf8')
  return brief
}
