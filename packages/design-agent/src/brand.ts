import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface BrandSystem {
  version: 1
  foundation: {
    strategy: 'preserve' | 'extend' | 'create'
    existingAssets: string[]
    lockedDecisions: string[]
    assumptions: string[]
  }
  creativeDirection: {
    summary: string
    keywords: string[]
    avoid: string[]
  }
  colorPalette: Array<{
    name: string
    value: string
    usage: string
  }>
  typefaces: Array<{
    family: string
    source: string
    roles: string[]
    weights: number[]
  }>
  interfaceDirection: string
  imageDirection: {
    summary: string
    subjects: string[]
    treatment: string
    avoid: string[]
  }
  motionDirection: {
    summary: string
    principles: string[]
    avoid: string[]
  }
  voice: {
    summary: string
    avoid: string[]
  }
}

export function parseBrandSystem(value: unknown): BrandSystem {
  const brand = record(value, 'brand system')
  if (brand.version !== 1) throw new Error('brand system version must be 1')

  const foundation =
    brand.foundation === undefined ? undefined : record(brand.foundation, 'foundation')
  const creativeDirection = record(brand.creativeDirection, 'creativeDirection')
  const imageDirection = record(brand.imageDirection, 'imageDirection')
  const motionDirection = record(brand.motionDirection, 'motionDirection')
  const voice = record(brand.voice, 'voice')

  return {
    version: 1,
    foundation: foundation
      ? {
          strategy: member(
            foundation.strategy,
            ['preserve', 'extend', 'create'] as const,
            'foundation.strategy',
          ),
          existingAssets: strings(foundation.existingAssets, 'foundation.existingAssets'),
          lockedDecisions: strings(foundation.lockedDecisions, 'foundation.lockedDecisions'),
          assumptions: strings(foundation.assumptions, 'foundation.assumptions'),
        }
      : { strategy: 'create', existingAssets: [], lockedDecisions: [], assumptions: [] },
    creativeDirection: {
      summary: string(creativeDirection.summary, 'creativeDirection.summary'),
      keywords: strings(creativeDirection.keywords, 'creativeDirection.keywords'),
      avoid: strings(creativeDirection.avoid, 'creativeDirection.avoid'),
    },
    colorPalette: array(brand.colorPalette, 'colorPalette').map((value, index) => {
      const color = record(value, `colorPalette[${index}]`)
      return {
        name: string(color.name, `colorPalette[${index}].name`),
        value: string(color.value, `colorPalette[${index}].value`),
        usage: string(color.usage, `colorPalette[${index}].usage`),
      }
    }),
    typefaces: array(brand.typefaces, 'typefaces').map((value, index) => {
      const typeface = record(value, `typefaces[${index}]`)
      return {
        family: string(typeface.family, `typefaces[${index}].family`),
        source: string(typeface.source, `typefaces[${index}].source`),
        roles: strings(typeface.roles, `typefaces[${index}].roles`),
        weights: weights(typeface.weights, `typefaces[${index}].weights`),
      }
    }),
    interfaceDirection: string(brand.interfaceDirection, 'interfaceDirection'),
    imageDirection: {
      summary: string(imageDirection.summary, 'imageDirection.summary'),
      subjects: strings(imageDirection.subjects, 'imageDirection.subjects'),
      treatment: string(imageDirection.treatment, 'imageDirection.treatment'),
      avoid: strings(imageDirection.avoid, 'imageDirection.avoid'),
    },
    motionDirection: {
      summary: string(motionDirection.summary, 'motionDirection.summary'),
      principles: strings(motionDirection.principles, 'motionDirection.principles'),
      avoid: strings(motionDirection.avoid, 'motionDirection.avoid'),
    },
    voice: {
      summary: string(voice.summary, 'voice.summary'),
      avoid: strings(voice.avoid, 'voice.avoid'),
    },
  }
}

export function readBrandSystem(workspacePath: string): BrandSystem {
  return parseBrandSystem(JSON.parse(readFileSync(brandPath(workspacePath), 'utf8')))
}

export function writeBrandSystem(workspacePath: string, value: unknown): BrandSystem {
  const brand = parseBrandSystem(value)
  const outputPath = brandPath(workspacePath)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(brand, null, 2)}\n`, 'utf8')
  return brand
}

function brandPath(workspacePath: string): string {
  return path.join(workspacePath, '.taste', 'brand.json')
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`)
  }
  return value
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${field} must be a string array`)
  }
  return value
}

function weights(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must contain font weights between 1 and 1000`)
  }
  const normalized = value.map((item) =>
    typeof item === 'string' && /^\d{1,4}$/.test(item) ? Number(item) : item,
  )
  if (!normalized.every((item) => Number.isInteger(item) && item >= 1 && item <= 1000)) {
    throw new Error(`${field} must contain font weights between 1 and 1000`)
  }
  return normalized as number[]
}

function member<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${field} must be one of ${values.join(', ')}`)
  }
  return value as T
}
