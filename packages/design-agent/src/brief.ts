import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('design brief must be an object')
  }
  const record = value as Record<string, unknown>
  for (const field of STRING_FIELDS) {
    if (typeof record[field] !== 'string' || record[field].trim() === '') {
      throw new Error(`design brief field ${field} must be a non-empty string`)
    }
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (!Array.isArray(record[field]) || !record[field].every((item) => typeof item === 'string')) {
      throw new Error(`design brief field ${field} must be a string array`)
    }
  }
  if (
    !Array.isArray(record.explicitAnswers) ||
    !record.explicitAnswers.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).question === 'string' &&
        typeof (item as Record<string, unknown>).answer === 'string',
    )
  ) {
    throw new Error('design brief field explicitAnswers must contain question and answer strings')
  }
  return record as unknown as DesignBrief
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
