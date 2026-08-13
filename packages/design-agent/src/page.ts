import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface PageLink {
  label: string
  target: string
}

export interface PageBlueprint {
  version: 1
  page: {
    title: string
    route: string
    description: string
  }
  architecture: {
    contract: string
    mode:
      | 'scan_compare'
      | 'read_understand'
      | 'persuade_convert'
      | 'explore_experience'
      | 'operate_monitor'
    novelty: 'low' | 'medium' | 'high'
    grid: string
    signatureRule: string
    rhythm: string
  }
  navigation: PageLink[]
  sections: Array<{
    id: string
    purpose: string
    userQuestion: string
    stage: 'orient' | 'qualify' | 'evaluate' | 'prove' | 'explain' | 'de_risk' | 'act' | 'continue'
    dependencies: string[]
    evidence: string[]
    copy: {
      eyebrow?: string
      heading: string
      body: string[]
      callsToAction: PageLink[]
    }
    layout: string
    componentNeeds: string[]
    assetNeeds: string[]
    transformation: {
      compact: string
      medium: string
      expanded: string
    }
  }>
  responsive: string[]
  interactions: string[]
  acceptanceCriteria: string[]
}

export function parsePageBlueprint(value: unknown): PageBlueprint {
  const blueprint = record(value, 'page blueprint')
  if (blueprint.version !== 1) throw new Error('page blueprint version must be 1')

  const page = record(blueprint.page, 'page')
  const architecture =
    blueprint.architecture === undefined
      ? undefined
      : record(blueprint.architecture, 'architecture')
  const sections = array(blueprint.sections, 'sections').map((value, index) => {
    const section = record(value, `sections[${index}]`)
    const copy = record(section.copy, `sections[${index}].copy`)
    return {
      id: string(section.id, `sections[${index}].id`),
      purpose: string(section.purpose, `sections[${index}].purpose`),
      userQuestion:
        section.userQuestion === undefined
          ? string(section.purpose, `sections[${index}].purpose`)
          : string(section.userQuestion, `sections[${index}].userQuestion`),
      stage:
        section.stage === undefined
          ? ('explain' as const)
          : member(
              section.stage,
              [
                'orient',
                'qualify',
                'evaluate',
                'prove',
                'explain',
                'de_risk',
                'act',
                'continue',
              ] as const,
              `sections[${index}].stage`,
            ),
      dependencies:
        section.dependencies === undefined
          ? []
          : strings(section.dependencies, `sections[${index}].dependencies`),
      evidence:
        section.evidence === undefined
          ? []
          : strings(section.evidence, `sections[${index}].evidence`),
      copy: {
        ...optionalString(copy.eyebrow, `sections[${index}].copy.eyebrow`),
        heading: string(copy.heading, `sections[${index}].copy.heading`),
        body: strings(copy.body, `sections[${index}].copy.body`),
        callsToAction: links(copy.callsToAction, `sections[${index}].copy.callsToAction`),
      },
      layout: string(section.layout, `sections[${index}].layout`),
      componentNeeds: strings(section.componentNeeds, `sections[${index}].componentNeeds`),
      assetNeeds: strings(section.assetNeeds, `sections[${index}].assetNeeds`),
      transformation:
        section.transformation === undefined
          ? {
              compact: 'Preserve the section content in logical source order.',
              medium: 'Preserve the section hierarchy with reduced simultaneity.',
              expanded: string(section.layout, `sections[${index}].layout`),
            }
          : transformation(section.transformation, index),
    }
  })

  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    throw new Error('page blueprint section ids must be unique')
  }
  const sectionIds = new Set(sections.map((section) => section.id))
  for (const [index, section] of sections.entries()) {
    if (section.dependencies.includes(section.id)) {
      throw new Error(`section ${section.id} cannot depend on itself`)
    }
    const missing = section.dependencies.find((dependency) => !sectionIds.has(dependency))
    if (missing) throw new Error(`section ${section.id} depends on unknown section ${missing}`)
    const later = section.dependencies.find(
      (dependency) => sections.findIndex(({ id }) => id === dependency) >= index,
    )
    if (later) throw new Error(`section ${section.id} must follow dependency ${later}`)
  }

  return {
    version: 1,
    page: {
      title: string(page.title, 'page.title'),
      route: route(page.route),
      description: string(page.description, 'page.description'),
    },
    architecture: architecture
      ? {
          contract: string(architecture.contract, 'architecture.contract'),
          mode: member(
            architecture.mode,
            [
              'scan_compare',
              'read_understand',
              'persuade_convert',
              'explore_experience',
              'operate_monitor',
            ] as const,
            'architecture.mode',
          ),
          novelty: member(
            architecture.novelty,
            ['low', 'medium', 'high'] as const,
            'architecture.novelty',
          ),
          grid: string(architecture.grid, 'architecture.grid'),
          signatureRule: string(architecture.signatureRule, 'architecture.signatureRule'),
          rhythm: string(architecture.rhythm, 'architecture.rhythm'),
        }
      : {
          contract: string(page.description, 'page.description'),
          mode: 'persuade_convert',
          novelty: 'medium',
          grid: 'Use the recorded section layouts.',
          signatureRule: 'No signature composition recorded.',
          rhythm: 'Preserve the recorded section order.',
        },
    navigation: links(blueprint.navigation, 'navigation'),
    sections,
    responsive: strings(blueprint.responsive, 'responsive'),
    interactions: strings(blueprint.interactions, 'interactions'),
    acceptanceCriteria: strings(blueprint.acceptanceCriteria, 'acceptanceCriteria'),
  }
}

function transformation(
  value: unknown,
  index: number,
): PageBlueprint['sections'][number]['transformation'] {
  const item = record(value, `sections[${index}].transformation`)
  return {
    compact: string(item.compact, `sections[${index}].transformation.compact`),
    medium: string(item.medium, `sections[${index}].transformation.medium`),
    expanded: string(item.expanded, `sections[${index}].transformation.expanded`),
  }
}

export function readPageBlueprint(workspacePath: string): PageBlueprint {
  return parsePageBlueprint(JSON.parse(readFileSync(pagePath(workspacePath), 'utf8')))
}

export function writePageBlueprint(workspacePath: string, value: unknown): PageBlueprint {
  const blueprint = parsePageBlueprint(value)
  const outputPath = pagePath(workspacePath)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(blueprint, null, 2)}\n`, 'utf8')
  return blueprint
}

function pagePath(workspacePath: string): string {
  return path.join(workspacePath, '.taste', 'page.json')
}

function links(value: unknown, field: string): PageLink[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((value, index) => {
    const link = record(value, `${field}[${index}]`)
    return {
      label: string(link.label, `${field}[${index}].label`),
      target: string(link.target, `${field}[${index}].target`),
    }
  })
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`)
  }
  return value
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${field} must be a string array`)
  }
  return value
}

function route(value: unknown): string {
  const result = string(value, 'page.route')
  if (!result.startsWith('/')) throw new Error('page.route must start with /')
  return result
}

function optionalString(value: unknown, field: string): { eyebrow?: string } {
  return value === undefined ? {} : { eyebrow: string(value, field) }
}

function member<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${field} must be one of ${values.join(', ')}`)
  }
  return value as T
}
