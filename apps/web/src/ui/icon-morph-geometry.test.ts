import { describe, expect, it } from 'vitest'
import {
  interpolateMorphPoints,
  morphPath,
  pairMorphTracks,
  type MorphPoint,
  type MorphTrack,
} from './icon-morph-geometry.js'

function track(points: MorphPoint[], closed = false): MorphTrack<string> {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), {
    x: 0,
    y: 0,
  })
  return {
    points,
    center: { x: center.x / points.length, y: center.y / points.length },
    closed,
    length: points.length,
    paint: 'currentColor',
  }
}

describe('icon morph geometry', () => {
  it('joins extra source strokes to the closest target instead of dropping them', () => {
    const source = [
      track([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
      track([
        { x: 8, y: 8 },
        { x: 9, y: 9 },
      ]),
    ]
    const target = [
      track([
        { x: 4, y: 4 },
        { x: 5, y: 5 },
      ]),
    ]

    const pairs = pairMorphTracks(source, target)

    expect(pairs).toHaveLength(2)
    expect(pairs.every((pair) => pair.to.center.x === 4.5 && pair.to.center.y === 4.5)).toBe(true)
  })

  it('interpolates every sampled point and emits one continuous SVG path', () => {
    const points = interpolateMorphPoints(
      [
        { x: 0, y: 0 },
        { x: 4, y: 2 },
      ],
      [
        { x: 2, y: 4 },
        { x: 8, y: 6 },
      ],
      0.5,
    )

    expect(points).toEqual([
      { x: 1, y: 2 },
      { x: 6, y: 4 },
    ])
    expect(morphPath(points)).toBe('M1 2L6 4')
  })
})
