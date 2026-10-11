import { readDesignArtifact, writeDesignArtifact } from './artifact-store.js'
import { array, fontWeights, list, member, record, string, strings } from './parse.js'

export const DESIGN_TYPE_SCALE_STEPS = [
  'display',
  'h1',
  'h2',
  'h3',
  'body',
  'small',
  'label',
] as const
export type DesignTypeScaleStep = (typeof DESIGN_TYPE_SCALE_STEPS)[number]

/** Page-wide values every section shares, so one page keeps one design language. */
export interface BrandDesignTokens {
  /** CSS lengths or clamp()/min()/max()/calc() expressions. */
  typeScale: Record<DesignTypeScaleStep, string>
  /** One to four non-pill radii from small to large, plus the pill radius. */
  radius: { scale: string[]; pill: string }
  spacing: { section: string; gutter: string; stack: string }
  buttons: { primary: string; secondary: string }
  /** Card and section surface policy, including the light/dark sequence. */
  surfaces: string
}

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
  /** Absent in brand systems approved before structured tokens existed. */
  designTokens?: BrandDesignTokens
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
  const designTokens =
    brand.designTokens === undefined || brand.designTokens === null
      ? undefined
      : parseDesignTokens(brand.designTokens)

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
    ...(designTokens ? { designTokens } : {}),
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

const CSS_SIZE =
  /^(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[a-z]{1,5}|%)?|(?:clamp|min|max|calc)\([-+*/\w\s.,%()]+\))$/iu
const PILL_RADIUS = /^(?:9{3,}|\d{4,})(?:\.\d+)?(?:px|rem|em)?$|^50%$/iu

/**
 * Lenient about format (numbers become px, radius may be a plain list) because the
 * model writes these values, strict about shape so later phases can rely on every
 * field. Values are restricted to CSS sizes because Build turns them into
 * custom properties.
 */
function parseDesignTokens(value: unknown): BrandDesignTokens {
  const tokens = record(value, 'designTokens')
  const typeScale = record(tokens.typeScale, 'designTokens.typeScale')
  const spacing = record(tokens.spacing, 'designTokens.spacing')
  const buttons = record(tokens.buttons, 'designTokens.buttons')
  return {
    typeScale: Object.fromEntries(
      DESIGN_TYPE_SCALE_STEPS.map((step) => [
        step,
        cssSize(typeScale[step], `designTokens.typeScale.${step}`),
      ]),
    ) as Record<DesignTypeScaleStep, string>,
    radius: parseRadius(tokens.radius),
    spacing: {
      section: cssSize(spacing.section, 'designTokens.spacing.section'),
      gutter: cssSize(spacing.gutter, 'designTokens.spacing.gutter'),
      stack: cssSize(spacing.stack, 'designTokens.spacing.stack'),
    },
    buttons: {
      primary: string(buttons.primary, 'designTokens.buttons.primary'),
      secondary: string(buttons.secondary, 'designTokens.buttons.secondary'),
    },
    surfaces: string(tokens.surfaces, 'designTokens.surfaces'),
  }
}

function parseRadius(value: unknown): BrandDesignTokens['radius'] {
  const field = 'designTokens.radius'
  let values: unknown[]
  let pill: string | undefined
  if (Array.isArray(value)) {
    values = value
  } else {
    const radius = record(value, field)
    values = list(radius.scale ?? radius.values, `${field}.scale`)
    pill = radius.pill === undefined ? undefined : cssSize(radius.pill, `${field}.pill`)
  }
  const sizes = values.map((entry, index) => cssSize(entry, `${field}.scale[${index}]`))
  const scale = sizes.filter((size) => !PILL_RADIUS.test(size))
  pill ??= sizes.find((size) => PILL_RADIUS.test(size)) ?? '999px'
  if (scale.length === 0 || scale.length > 4) {
    throw new Error(`${field}.scale must list one to four radii besides the pill radius`)
  }
  return { scale, pill }
}

function cssSize(value: unknown, field: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? '0' : `${value}px`
  if (typeof value === 'string') {
    const size = value.trim()
    if (size.length <= 120 && CSS_SIZE.test(size)) return size
  }
  throw new Error(
    `${field} must be a CSS length or a clamp(), min(), max() or calc() expression, such as "1.25rem" or "clamp(2.5rem, 6vw, 5rem)"`,
  )
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
