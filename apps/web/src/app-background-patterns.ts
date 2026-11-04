import type { AppBackgroundEffect } from './app-background.js'

/**
 * The tiles behind Window background › Effect. Each is a small SVG built once
 * and used as a CSS mask over the text colour (app-background.css), so one
 * tile reads in light and dark and follows the theme without being rebuilt.
 * Both run horizontally (repeat-x) and fade out down the window from its top
 * edge. They are each effect standing still: what shows wherever the moving
 * canvas (app-background-motion.ts) cannot be drawn.
 */
export type EffectPattern = {
  /** A CSS url() of the tile. */
  image: string
  /** Its CSS background/mask size: width and height in CSS pixels. */
  size: string
  /** The same size as numbers, for a preview that draws the tile smaller. */
  width: number
  height: number
}

/** Columns of the dither tile: one turn of the 8×8 Bayer matrix. */
const DITHER_COLUMNS = 8
/** Rows of the dither tile, top to bottom. */
export const DITHER_ROWS = 224
/** CSS pixels per dither cell, so the cells read as pixels. */
export const DITHER_CELL = 2
/** Share of cells lit in the top row; the fade runs to none at the bottom. */
export const DITHER_TOP = 0.6

/** Distance between halftone dots in a column, in CSS pixels. */
export const HALFTONE_PITCH = 8
const HALFTONE_ROWS = 56
/** Radius of the largest dot, at the top edge. */
export const HALFTONE_RADIUS = 3.4

/** How far down the window both effects reach, in CSS pixels: the tiles' height. */
export const EFFECT_BAND = DITHER_ROWS * DITHER_CELL

/** The 8×8 ordered-dither (Bayer) threshold matrix, values 0 to 63. */
export function bayerMatrix(): number[][] {
  // Each doubling puts four copies side by side: 4M, 4M+2 over 4M+3, 4M+1.
  let matrix = [[0]]
  while (matrix.length < 8) {
    const previous = matrix
    const quadrant = (offset: number) => previous.map((row) => row.map((v) => 4 * v + offset))
    const [topLeft, topRight, bottomLeft, bottomRight] = [
      quadrant(0),
      quadrant(2),
      quadrant(3),
      quadrant(1),
    ]
    matrix = [
      ...topLeft.map((row, y) => [...row, ...(topRight[y] ?? [])]),
      ...bottomLeft.map((row, y) => [...row, ...(bottomRight[y] ?? [])]),
    ]
  }
  return matrix
}

/** How much of the tile is lit at `t` (0 at the top edge, 1 at the bottom). */
function fade(t: number, top: number, curve: number): number {
  return top * Math.pow(Math.max(0, 1 - t), curve)
}

/** Which cells of each dither row are lit: an ordered dither of the fade. */
export function ditherRows(): boolean[][] {
  const matrix = bayerMatrix()
  return Array.from({ length: DITHER_ROWS }, (_, y) => {
    const level = fade(y / DITHER_ROWS, DITHER_TOP, 2)
    return Array.from(
      { length: DITHER_COLUMNS },
      (_, x) => level > ((matrix[y % 8]?.[x] ?? 0) + 0.5) / 64,
    )
  })
}

function svgUrl(
  width: number,
  height: number,
  rendering: 'crispEdges' | 'geometricPrecision',
  body: string,
): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="${rendering}">${body}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

function ditherPattern(): EffectPattern {
  // Neighbouring lit cells in a row become one rectangle.
  let path = ''
  ditherRows().forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x++
        continue
      }
      let end = x
      while (end < row.length && row[end]) end++
      path += `M${x} ${y}h${end - x}v1h${x - end}z`
      x = end
    }
  })
  const width = DITHER_COLUMNS * DITHER_CELL
  const height = DITHER_ROWS * DITHER_CELL
  return {
    // Hard cell edges, so each cell reads as a pixel when scaled up.
    image: svgUrl(DITHER_COLUMNS, DITHER_ROWS, 'crispEdges', `<path d="${path}"/>`),
    size: `${width}px ${height}px`,
    width,
    height,
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function halftonePattern(): EffectPattern {
  // Two columns, the second half a pitch lower: the classic staggered grid.
  const width = HALFTONE_PITCH * 2
  const height = HALFTONE_PITCH * HALFTONE_ROWS
  let circles = ''
  for (let row = 0; row < HALFTONE_ROWS; row++) {
    for (const [cx, cy] of [
      [HALFTONE_PITCH / 2, row * HALFTONE_PITCH + HALFTONE_PITCH / 2],
      [HALFTONE_PITCH * 1.5, (row + 1) * HALFTONE_PITCH],
    ] as const) {
      const radius = HALFTONE_RADIUS * fade(cy / height, 1, 1.5)
      if (radius < 0.3) continue
      circles += `<circle cx="${cx}" cy="${cy}" r="${round(radius)}"/>`
    }
  }
  return {
    image: svgUrl(width, height, 'geometricPrecision', circles),
    size: `${width}px ${height}px`,
    width,
    height,
  }
}

const patterns = new Map<AppBackgroundEffect, EffectPattern>()

/** The tile an effect is drawn from, built on first use and then reused. */
export function effectPattern(effect: AppBackgroundEffect): EffectPattern {
  let pattern = patterns.get(effect)
  if (!pattern) {
    pattern = effect === 'dither' ? ditherPattern() : halftonePattern()
    patterns.set(effect, pattern)
  }
  return pattern
}

/** The CSS variables that hand an effect's tile to app-background.css. */
export type EffectPatternStyle = {
  '--app-bg-pattern'?: string
  '--app-bg-pattern-size'?: string
}

export function effectPatternStyle(effect: AppBackgroundEffect): EffectPatternStyle {
  const pattern = effectPattern(effect)
  return { '--app-bg-pattern': pattern.image, '--app-bg-pattern-size': pattern.size }
}
