import { readDesignArtifact, writeDesignArtifact } from './artifact-store.js'
import { array, fontWeights, list, member, record, string, strings } from './parse.js'

export interface BrandSystem {
  version: 1
  foundation: {
    strategy: 'preserve' | 'extend' | 'create'
    existingAssets: string[]
    assetActions: Array<{
      asset: string
      action: 'protect' | 'preserve' | 'evolve' | 'retire' | 'create'
      reason: string
    }>
    lockedDecisions: string[]
    assumptions: string[]
  }
  creativeDirection: {
    summary: string
    traits: Array<{
      quality: string
      boundary: string
    }>
    productiveTension: string
    signatureDevice: {
      description: string
      status: 'existing' | 'candidate' | 'validated'
      invariants: string[]
    }
    restraint: string
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
  const typefaces = array(brand.typefaces, 'typefaces').map((value, index) => {
    const typeface = record(value, `typefaces[${index}]`)
    return {
      family: string(typeface.family, `typefaces[${index}].family`),
      source: string(typeface.source, `typefaces[${index}].source`),
      roles: strings(typeface.roles, `typefaces[${index}].roles`),
      weights: fontWeights(typeface.weights, `typefaces[${index}].weights`),
    }
  })
  if (typefaces.length > 2) throw new Error('brand system must use at most two typeface families')
  for (const { family } of typefaces) {
    if (/^(?:archivo|ibm plex mono)(?:\s|$)/iu.test(family.trim())) {
      throw new Error(`brand system typeface ${family} is not allowed`)
    }
  }

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
          assetActions:
            foundation.assetActions === undefined
              ? []
              : list(foundation.assetActions, 'foundation.assetActions').map((value, index) => {
                  const item = record(value, `foundation.assetActions[${index}]`)
                  return {
                    asset: string(item.asset, `foundation.assetActions[${index}].asset`),
                    action: member(
                      item.action,
                      ['protect', 'preserve', 'evolve', 'retire', 'create'] as const,
                      `foundation.assetActions[${index}].action`,
                    ),
                    reason: string(item.reason, `foundation.assetActions[${index}].reason`),
                  }
                }),
          lockedDecisions: strings(foundation.lockedDecisions, 'foundation.lockedDecisions'),
          assumptions: strings(foundation.assumptions, 'foundation.assumptions'),
        }
      : {
          strategy: 'create',
          existingAssets: [],
          assetActions: [],
          lockedDecisions: [],
          assumptions: [],
        },
    creativeDirection: {
      summary: string(creativeDirection.summary, 'creativeDirection.summary'),
      traits:
        creativeDirection.traits === undefined
          ? strings(creativeDirection.keywords, 'creativeDirection.keywords').map((quality) => ({
              quality,
              boundary: `not an exaggerated or generic version of ${quality}`,
            }))
          : list(creativeDirection.traits, 'creativeDirection.traits').map((value, index) => {
              const trait = record(value, `creativeDirection.traits[${index}]`)
              return {
                quality: string(trait.quality, `creativeDirection.traits[${index}].quality`),
                boundary: string(trait.boundary, `creativeDirection.traits[${index}].boundary`),
              }
            }),
      productiveTension:
        creativeDirection.productiveTension === undefined
          ? 'Coherent and distinctive'
          : string(creativeDirection.productiveTension, 'creativeDirection.productiveTension'),
      signatureDevice:
        creativeDirection.signatureDevice === undefined
          ? {
              description: 'No signature device recorded',
              status: 'candidate',
              invariants: [],
            }
          : parseSignatureDevice(creativeDirection.signatureDevice),
      restraint:
        creativeDirection.restraint === undefined
          ? 'Use the signature device only where it supports recognition or hierarchy.'
          : string(creativeDirection.restraint, 'creativeDirection.restraint'),
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
    typefaces,
    interfaceDirection: string(brand.interfaceDirection, 'interfaceDirection'),
    imageDirection: {
      summary: string(imageDirection.summary, 'imageDirection.summary'),
      subjects: strings(imageDirection.subjects, 'imageDirection.subjects'),
      treatment: string(imageDirection.treatment, 'imageDirection.treatment'),
      avoid: strings(imageDirection.avoid, 'imageDirection.avoid'),
    },
    motionDirection: {
      summary: string(motionDirection.summary, 'motionDirection.summary'),
      principles: motionPrinciples(motionDirection.principles),
      avoid: strings(motionDirection.avoid, 'motionDirection.avoid'),
    },
    voice: {
      summary: string(voice.summary, 'voice.summary'),
      avoid: strings(voice.avoid, 'voice.avoid'),
    },
  }
}

function motionPrinciples(value: unknown): string[] {
  const field = 'motionDirection.principles'
  if (typeof value === 'string') return [string(value, field)]
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a string array or an array of flat string objects`)
  }

  return value.map((entry, index) => {
    if (typeof entry === 'string') return string(entry, `${field}[${index}]`)
    const details = Object.entries(record(entry, `${field}[${index}]`))
    if (details.length === 0) {
      throw new Error(`${field}[${index}] must contain at least one string field`)
    }
    return details
      .map(([name, detail]) => {
        const label = name
          .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
          .replace(/[_-]+/gu, ' ')
          .toLowerCase()
        return `${label}: ${string(detail, `${field}[${index}].${name}`)}`
      })
      .join('; ')
  })
}

function parseSignatureDevice(value: unknown): BrandSystem['creativeDirection']['signatureDevice'] {
  const device = record(value, 'creativeDirection.signatureDevice')
  return {
    description: string(device.description, 'creativeDirection.signatureDevice.description'),
    status: member(
      device.status,
      ['existing', 'candidate', 'validated'] as const,
      'creativeDirection.signatureDevice.status',
    ),
    invariants: strings(device.invariants, 'creativeDirection.signatureDevice.invariants'),
  }
}

export function readBrandSystem(workspacePath: string): BrandSystem {
  return parseBrandSystem(readDesignArtifact(workspacePath, 'brand.json'))
}

export function writeBrandSystem(workspacePath: string, value: unknown): BrandSystem {
  const brand = parseBrandSystem(value)
  writeDesignArtifact(workspacePath, 'brand.json', brand)
  return brand
}
