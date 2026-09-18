/**
 * Name-based profile picture. Same idea as an identicon — the same name always
 * yields the same picture, so a profile without a photo has a stable face in
 * the rail, on the profile page, and with every provider — but drawn for a
 * circle, not a square: every style is built from the center out, so nothing
 * gets clipped by the crop. Colors are muted and analogous (one hue family per
 * name, low chroma) so the picture sits quietly next to the app's chrome.
 */
export const AVATAR_STYLES = ['mandala', 'orb', 'marble'] as const
export type AvatarStyle = (typeof AVATAR_STYLES)[number]
export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'mandala'

/** Canvas is 100×100; the crop is the inscribed circle. */
export const AVATAR_SIZE = 100

export type AvatarTones = {
  hue: number
  /** True when the ground is dark and the inks light. */
  dark: boolean
  ground: string
  inks: readonly [string, string]
}

/** Polar pixels: rings of tiles under a rotational symmetry, like a coin face. */
export type MandalaAvatar = AvatarTones & {
  style: 'mandala'
  symmetry: 'mirror' | 'triple' | 'quad'
  sectors: number
  /** Outer → inner ring order, each a `sectors`-long row of `CELL` values. */
  rings: readonly (readonly Cell[])[]
  core: Cell
}

/** A soft analogous gradient with one highlight, the quiet default look of many apps. */
export type OrbAvatar = AvatarTones & {
  style: 'orb'
  angle: number
  stops: readonly [string, string, string]
  glow: { x: number; y: number; r: number }
}

/** Overlapping translucent discs; reads as a blurred marble at rail size. */
export type MarbleAvatar = AvatarTones & {
  style: 'marble'
  drops: readonly { x: number; y: number; r: number; color: string }[]
}

export type GeneratedAvatar = MandalaAvatar | OrbAvatar | MarbleAvatar

export const CELL = { ground: 0, ink: 1, glint: 2 } as const
export type Cell = (typeof CELL)[keyof typeof CELL]

const MANDALA_SECTORS = 12
const MANDALA_RINGS = 3
const MANDALA_SYMMETRIES = ['mirror', 'triple', 'quad'] as const

export function generatedAvatar(
  name: string,
  style: AvatarStyle = DEFAULT_AVATAR_STYLE,
): GeneratedAvatar {
  const key = normalizeAvatarName(name)
  // Independent hashes so color never correlates with form.
  const shape = hash32(key, 0x9747b28c)
  const spark = hash32(key, 0x68e31da4)
  const paint = hash32(key, 0x2545f491)
  const tones = avatarTones(paint)
  switch (style) {
    case 'mandala':
      return mandala(shape, spark, tones)
    case 'orb':
      return orb(shape, tones)
    case 'marble':
      return marble(shape, tones)
  }
}

function avatarTones(paint: number): AvatarTones {
  const hue = paint % 360
  const dark = ((paint >>> 9) & 1) === 1
  return {
    hue,
    dark,
    ground: dark ? hsl(hue, 18, 24) : hsl(hue, 22, 88),
    inks: dark
      ? [hsl(hue + 16, 30, 74), hsl(hue - 34, 26, 56)]
      : [hsl(hue + 16, 28, 40), hsl(hue - 34, 30, 62)],
  }
}

/**
 * Sector 0 starts at twelve o'clock and runs clockwise, so `mirror` folds
 * left onto right like a face; `triple` and `quad` repeat every 120° / 90°.
 * `shape` decides which tiles are painted, `spark` which of those use the
 * second ink; at most 18 bits of each are read.
 */
function mandala(shape: number, spark: number, tones: AvatarTones): MandalaAvatar {
  const symmetry = MANDALA_SYMMETRIES[shape % MANDALA_SYMMETRIES.length]!
  const fold = symmetry === 'mirror' ? 2 : symmetry === 'triple' ? 3 : 4
  const unique = MANDALA_SECTORS / fold
  const rings = Array.from({ length: MANDALA_RINGS }, (_, ring) => {
    const base = 2 + ring * unique
    return Array.from({ length: MANDALA_SECTORS }, (_, sector): Cell => {
      const source =
        symmetry === 'mirror' ? Math.min(sector, MANDALA_SECTORS - 1 - sector) : sector % unique
      const bit = base + source
      if (((shape >>> bit) & 1) === 0) return CELL.ground
      return ((spark >>> bit) & 1) === 1 && ((spark >>> (bit + 9)) & 1) === 1
        ? CELL.glint
        : CELL.ink
    })
  })
  // The eye of the coin: a solid core when the inner ring is sparse, ground otherwise.
  const innerPainted = rings.at(-1)!.filter((cell) => cell !== CELL.ground).length
  const core: Cell = innerPainted < MANDALA_SECTORS / 2 ? CELL.ink : CELL.ground
  if (!rings.flat().some((cell) => cell !== CELL.ground)) {
    rings[1] = Array.from({ length: MANDALA_SECTORS }, (): Cell => CELL.ink)
  }
  return { ...tones, style: 'mandala', symmetry, sectors: MANDALA_SECTORS, rings, core }
}

function orb(shape: number, tones: AvatarTones): OrbAvatar {
  const { hue, dark } = tones
  const angle = (shape % 8) * 45
  const light = dark ? [58, 42, 28] : [90, 76, 62]
  const stops = [
    hsl(hue - 12, 30, light[0]!),
    hsl(hue + 14, 32, light[1]!),
    hsl(hue + 40, 30, light[2]!),
  ] as const
  const corner = (shape >>> 3) & 3
  return {
    ...tones,
    style: 'orb',
    angle,
    stops,
    glow: {
      x: corner & 1 ? 68 : 32,
      y: corner & 2 ? 66 : 34,
      r: 30 + ((shape >>> 5) & 3) * 6,
    },
  }
}

function marble(shape: number, tones: AvatarTones): MarbleAvatar {
  const { hue, dark } = tones
  const colors = [
    hsl(hue + 10, 30, dark ? 62 : 46),
    hsl(hue - 30, 28, dark ? 48 : 60),
    hsl(hue + 44, 26, dark ? 74 : 34),
    hsl(hue - 8, 22, dark ? 36 : 78),
  ]
  const drops = colors.map((color, index) => {
    const bits = shape >>> (index * 7)
    return {
      x: 22 + (bits & 7) * 8,
      y: 22 + ((bits >>> 3) & 7) * 8,
      r: 26 + ((bits >>> 6) & 1) * 10 + (3 - index) * 3,
      color,
    }
  })
  return { ...tones, style: 'marble', drops }
}

/** Case and surrounding whitespace never change the picture; a typo fix should not. */
export function normalizeAvatarName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${((hue % 360) + 360) % 360} ${saturation}% ${lightness}%)`
}

/** FNV-1a over UTF-16 code units with a murmur3 finalizer, so one-character
 *  names still spread across every bit that picks form and color. */
function hash32(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}
