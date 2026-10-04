import type { BrandSystem } from './brand.js'
import { boundedInteger, record } from './parse.js'

export const GRADIENT_PURPOSES = ['card', 'section', 'page'] as const
export type GradientPurpose = (typeof GRADIENT_PURPOSES)[number]

export interface GradientRecipe {
  purpose: GradientPurpose
  background: string
  contentSurface: string
  usage: string
}

export interface GradientSet {
  version: 1
  seed: number
  recipes: GradientRecipe[]
}

interface GradientRequest {
  background: string
  surface: string
  accent: string
  secondary: string
  seed: number
}

interface GradientPoint {
  x: number
  y: number
}

const HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/iu

export function generateGradientSet(input: unknown): GradientSet {
  const request = parseRequest(input)
  const random = mulberry32(request.seed)
  return {
    version: 1,
    seed: request.seed,
    recipes: [
      recipe('card', request, random, 0.42, 0.28),
      recipe('section', request, random, 0.3, 0.18),
      recipe('page', request, random, 0.2, 0.12),
    ],
  }
}

export function gradientSetForBrand(brand: BrandSystem): GradientSet | undefined {
  const palette = brand.colorPalette
    .map((color) => ({ ...color, value: normalizeHex(color.value) }))
    .filter((color): color is typeof color & { value: string } => color.value !== undefined)
  if (!palette.length) return undefined

  const pick = (pattern: RegExp, fallback: number) =>
    palette.find((color) => pattern.test(`${color.name} ${color.usage}`))?.value ??
    palette[Math.min(fallback, palette.length - 1)]!.value

  return generateGradientSet({
    background: pick(/canvas|background|page\s+base/iu, 0),
    surface: pick(/surface|card/iu, 0),
    accent: pick(/accent|primary|action|brand/iu, 1),
    secondary: pick(/secondary|supporting|surface\s*alt/iu, 2),
    seed: hash(
      `${brand.creativeDirection.summary}:${brand.creativeDirection.signatureDevice?.description ?? ''}`,
    ),
  })
}

function recipe(
  purpose: GradientPurpose,
  request: GradientRequest,
  random: () => number,
  primaryAlpha: number,
  secondaryAlpha: number,
): GradientRecipe {
  const first = point(random)
  const second = point(random)
  const accent = rgba(request.accent, primaryAlpha)
  const secondary = rgba(request.secondary, secondaryAlpha)
  return {
    purpose,
    background: [
      `radial-gradient(ellipse 90% 80% at ${first.x}% ${first.y}%, ${accent} 0%, transparent 68%)`,
      `radial-gradient(ellipse 80% 90% at ${second.x}% ${second.y}%, ${secondary} 0%, transparent 72%)`,
      `linear-gradient(135deg, ${request.surface} 0%, ${request.background} 100%)`,
    ].join(', '),
    contentSurface: request.surface,
    usage:
      purpose === 'card'
        ? 'Use as a 6-12px outer card substrate with the opaque content surface nested inside.'
        : purpose === 'section'
          ? 'Use behind one meaningful section; keep text and controls on opaque palette surfaces.'
          : 'Use as a quiet page atmosphere, never as a different theme between adjacent sections.',
  }
}

function point(random: () => number): GradientPoint {
  return { x: Math.round(12 + random() * 76), y: Math.round(10 + random() * 80) }
}

function parseRequest(input: unknown): GradientRequest {
  const value = record(input, 'gradient request')
  return {
    background: color(value.background, 'background'),
    surface: color(value.surface, 'surface'),
    accent: color(value.accent, 'accent'),
    secondary: color(value.secondary, 'secondary'),
    seed: integer(value.seed, 'seed', 0, 0xffffffff),
  }
}

function color(value: unknown, field: string): string {
  const normalized = normalizeHex(value)
  if (!normalized) throw new Error(`gradient ${field} must be an opaque sRGB hex color`)
  return normalized
}

function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string' || !HEX.test(value)) return undefined
  const hex = value
  return (
    hex.length === 4
      ? `#${Array.from(hex.slice(1), (character) => character.repeat(2)).join('')}`
      : hex
  ).toUpperCase()
}

function rgba(value: string, alpha: number): string {
  const channels = [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16))
  return `rgba(${channels.join(', ')} / ${alpha})`
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  const result = boundedInteger(value, minimum, maximum)
  if (result === undefined) {
    throw new Error(`gradient ${field} must be an integer from ${minimum} to ${maximum}`)
  }
  return result
}

function hash(value: string): number {
  let result = 2166136261
  for (const character of value) {
    result ^= character.codePointAt(0)!
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
