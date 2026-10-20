/**
 * The Windows taskbar has no badge count of its own; an overlay icon carries
 * it instead. The overlay is drawn here as raw pixels so the shell ships no
 * image files and the renderer never hands the main process an image.
 *
 * A filled circle in the sidebar's "needs you" amber with the count in dark
 * strokes: 1 to 9, then 9+. Strokes are anti-aliased by supersampling.
 */

/** The sidebar's needs-you mark (`--warning`, dark theme) and a near-black ink. */
const BADGE_RGB = [0xf2, 0xc9, 0x4c] as const
const INK_RGB = [0x1b, 0x1b, 0x1b] as const
const SAMPLES = 4

type Point = readonly [number, number]
type Stroke = readonly Point[]

/** Glyph width as a share of its height. */
const GLYPH_WIDTH = 0.58

function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  steps = 18,
): Point[] {
  const points: Point[] = []
  for (let step = 0; step <= steps; step += 1) {
    const angle = from + ((to - from) * step) / steps
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)])
  }
  return points
}

const PI = Math.PI

// Unit glyphs: height 1, width GLYPH_WIDTH, y grows downwards, angles follow
// the screen (a quarter turn past zero points down).
const SIX: Stroke[] = [
  arc(0.29, 0.68, 0.27, 0.3, 0, 2 * PI, 24),
  arc(0.6, 0.72, 0.58, 0.7, PI - 0.02, 1.5 * PI - 0.32),
]

const GLYPHS = new Map<string, readonly Stroke[]>(
  Object.entries({
    '1': [
      [
        [0.1, 0.2],
        [0.34, 0],
        [0.34, 1],
      ],
    ],
    '2': [[...arc(0.29, 0.28, 0.27, 0.27, PI + 0.15, 2 * PI + 0.45), [0.02, 1], [0.58, 1]]],
    '3': [
      arc(0.28, 0.25, 0.24, 0.23, PI + 0.55, 2.5 * PI),
      arc(0.29, 0.73, 0.28, 0.27, -0.5 * PI, PI - 0.55),
    ],
    '4': [
      [
        [0.44, 1],
        [0.44, 0],
        [0.02, 0.68],
        [0.6, 0.68],
      ],
    ],
    '5': [[[0.53, 0], [0.09, 0], [0.05, 0.45], ...arc(0.29, 0.68, 0.28, 0.32, -2.35, PI - 0.6)]],
    '6': SIX,
    '7': [
      [
        [0.02, 0],
        [0.58, 0],
        [0.2, 1],
      ],
    ],
    '8': [arc(0.29, 0.25, 0.23, 0.24, 0, 2 * PI, 24), arc(0.29, 0.73, 0.28, 0.27, 0, 2 * PI, 24)],
    '9': SIX.map((stroke) => stroke.map(([x, y]) => [GLYPH_WIDTH - x, 1 - y] as const)),
    '+': [
      [
        [0.29, 0.24],
        [0.29, 0.76],
      ],
      [
        [0.03, 0.5],
        [0.55, 0.5],
      ],
    ],
  }),
)

/** What the badge says: the count up to nine, then 9+. Nothing for zero. */
export function badgeLabel(count: number): string {
  if (!Number.isFinite(count) || count < 1) return ''
  return count > 9 ? '9+' : String(Math.floor(count))
}

type Segment = { ax: number; ay: number; bx: number; by: number }
/** A label's strokes in pixels, and how wide they are drawn. */
type PlacedLabel = { segments: Segment[]; width: number }

/** The label's strokes placed in a `size` px square, with their stroke width. */
function labelSegments(label: string, size: number): PlacedLabel {
  const glyphHeight = size * (label.length > 1 ? 0.34 : 0.5)
  const gap = glyphHeight * 0.16
  const advance = glyphHeight * GLYPH_WIDTH
  const total = advance * label.length + gap * (label.length - 1)
  let left = (size - total) / 2
  const top = (size - glyphHeight) / 2
  const segments: Segment[] = []
  for (const character of label) {
    for (const stroke of GLYPHS.get(character) ?? []) {
      for (let index = 1; index < stroke.length; index += 1) {
        const [ax, ay] = stroke[index - 1]!
        const [bx, by] = stroke[index]!
        segments.push({
          ax: left + ax * glyphHeight,
          ay: top + ay * glyphHeight,
          bx: left + bx * glyphHeight,
          by: top + by * glyphHeight,
        })
      }
    }
    left += advance + gap
  }
  return { segments, width: size * (label.length > 1 ? 0.09 : 0.12) }
}

function distanceToSegment(x: number, y: number, segment: Segment): number {
  const dx = segment.bx - segment.ax
  const dy = segment.by - segment.ay
  const length = dx * dx + dy * dy
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - segment.ax) * dx + (y - segment.ay) * dy) / length))
  return Math.hypot(x - (segment.ax + t * dx), y - (segment.ay + t * dy))
}

/**
 * The badge for `count` as premultiplied BGRA pixels, `size` px square, the
 * layout `nativeImage.createFromBitmap` takes on Windows. Undefined for zero.
 */
export function badgeBitmap(count: number, size: number): Buffer | undefined {
  const label = badgeLabel(count)
  if (!label || !Number.isInteger(size) || size < 8 || size > 256) return undefined
  const { segments, width } = labelSegments(label, size)
  const radius = size / 2
  const half = width / 2
  const pixels = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      let disc = 0
      let ink = 0
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = column + (sx + 0.5) / SAMPLES
          const y = row + (sy + 0.5) / SAMPLES
          if (Math.hypot(x - radius, y - radius) > radius) continue
          disc += 1
          if (segments.some((segment) => distanceToSegment(x, y, segment) <= half)) ink += 1
        }
      }
      if (disc === 0) continue
      const alpha = disc / (SAMPLES * SAMPLES)
      const inkShare = ink / disc
      const offset = (row * size + column) * 4
      const channel = (index: 0 | 1 | 2) =>
        Math.round((BADGE_RGB[index] * (1 - inkShare) + INK_RGB[index] * inkShare) * alpha)
      pixels[offset] = channel(2)
      pixels[offset + 1] = channel(1)
      pixels[offset + 2] = channel(0)
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

/** What a screen reader and the taskbar tooltip say about the badge. */
export function badgeDescription(count: number): string {
  return count === 1 ? '1 chat needs you' : `${count} chats need you`
}
