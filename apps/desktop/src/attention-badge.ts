/**
 * The Windows taskbar has no badge count of its own; an overlay icon carries
 * it instead. The overlay is drawn here as raw pixels so the shell ships no
 * image files and the renderer never hands the main process an image.
 *
 * A dot in the sidebar's "needs you" amber with a thin dark ring that keeps it
 * apart from the app icon underneath, the same mark the sidebar uses. Digits at
 * 16 px looked cramped and cheap, so the count lives in the overlay's
 * description (the taskbar tooltip and screen readers) instead. Edges are
 * anti-aliased by supersampling.
 */

/** The sidebar's needs-you mark (`--warning`, dark theme) and the ring's ink. */
const DOT_RGB = [0xf2, 0xc9, 0x4c] as const
const RING_RGB = [0x16, 0x16, 0x16] as const
/** The dot's diameter and the ring's width as shares of the overlay's size. */
const DOT_SHARE = 0.7
const RING_SHARE = 0.07
const SAMPLES = 4

/**
 * The badge for `count` as premultiplied BGRA pixels, `size` px square, the
 * layout `nativeImage.createFromBitmap` takes on Windows. Undefined for zero.
 * Every count draws the same dot; the description says how many.
 */
export function badgeBitmap(count: number, size: number): Buffer | undefined {
  if (!Number.isFinite(count) || count < 1) return undefined
  if (!Number.isInteger(size) || size < 8 || size > 256) return undefined
  const center = size / 2
  const dot = (size * DOT_SHARE) / 2
  const outer = dot + size * RING_SHARE
  const pixels = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      let fill = 0
      let ring = 0
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const distance = Math.hypot(
            column + (sx + 0.5) / SAMPLES - center,
            row + (sy + 0.5) / SAMPLES - center,
          )
          if (distance <= dot) fill += 1
          else if (distance <= outer) ring += 1
        }
      }
      if (fill + ring === 0) continue
      const samples = SAMPLES * SAMPLES
      const offset = (row * size + column) * 4
      const channel = (index: 0 | 1 | 2) =>
        Math.round((DOT_RGB[index] * fill + RING_RGB[index] * ring) / samples)
      pixels[offset] = channel(2)
      pixels[offset + 1] = channel(1)
      pixels[offset + 2] = channel(0)
      pixels[offset + 3] = Math.round(((fill + ring) / samples) * 255)
    }
  }
  return pixels
}

/** What a screen reader and the taskbar tooltip say about the badge. */
export function badgeDescription(count: number): string {
  return count === 1 ? '1 chat needs you' : `${count} chats need you`
}
