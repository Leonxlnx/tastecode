import { describe, expect, it } from 'vitest'
import {
  AVATAR_STYLES,
  CELL,
  DEFAULT_AVATAR_STYLE,
  generatedAvatar,
  normalizeAvatarName,
  type Cell,
} from './generated-avatar.js'

const NAMES = Array.from({ length: 300 }, (_, index) => `user${index}`)
const HSL = /^hsl\((\d+) (\d+)% (\d+)%\)$/u

function parts(color: string): [number, number, number] {
  const match = color.match(HSL)
  expect(match, color).toBeTruthy()
  return [Number(match![1]), Number(match![2]), Number(match![3])]
}

function rotate<T>(ring: readonly T[], by: number): T[] {
  return ring.map((_, index) => ring[(index + by) % ring.length]!)
}

describe('generated avatar', () => {
  it('is deterministic and ignores case and surrounding whitespace', () => {
    expect(generatedAvatar('Blue Emi')).toEqual(generatedAvatar('Blue Emi'))
    expect(generatedAvatar('  blue emi ')).toEqual(generatedAvatar('BLUE EMI'))
    expect(normalizeAvatarName('  Ｌeon ')).toBe('leon')
    expect(generatedAvatar('Leon').style).toBe(DEFAULT_AVATAR_STYLE)
  })

  it('keeps every color muted and in one hue family, on a dark or a light ground', () => {
    for (const style of AVATAR_STYLES) {
      for (const name of [...NAMES.slice(0, 60), '', 'a', 'Ada Lovelace']) {
        const avatar = generatedAvatar(name, style)
        const [, groundSaturation, groundLightness] = parts(avatar.ground)
        expect(groundSaturation).toBeLessThanOrEqual(30)
        expect(avatar.dark ? groundLightness < 40 : groundLightness > 75).toBe(true)
        for (const ink of avatar.inks) {
          const [hue, saturation, lightness] = parts(ink)
          expect(saturation).toBeLessThanOrEqual(36)
          expect(avatar.dark ? lightness > 45 : lightness < 70).toBe(true)
          const distance = Math.abs(((hue - avatar.hue + 540) % 360) - 180)
          expect(distance).toBeLessThanOrEqual(40)
        }
      }
    }
    const grounds = NAMES.map((name) => generatedAvatar(name).dark)
    expect(grounds.filter(Boolean).length).toBeGreaterThan(100)
    expect(grounds.filter((dark) => !dark).length).toBeGreaterThan(100)
  })

  it('folds the mandala under the symmetry the hash picked and never leaves it blank', () => {
    const seen = new Set<string>()
    for (const name of NAMES) {
      const avatar = generatedAvatar(name, 'mandala')
      if (avatar.style !== 'mandala') throw new Error('expected a mandala')
      seen.add(avatar.symmetry)
      expect(avatar.rings).toHaveLength(3)
      expect(avatar.rings.flat().some((cell) => cell !== CELL.ground)).toBe(true)
      for (const ring of avatar.rings) {
        expect(ring).toHaveLength(avatar.sectors)
        if (avatar.symmetry === 'mirror') expect(ring).toEqual([...ring].reverse())
        else
          expect(ring).toEqual(
            rotate(ring, avatar.sectors / (avatar.symmetry === 'triple' ? 3 : 4)),
          )
      }
      const cells: Cell[] = [...avatar.rings.flat(), avatar.core]
      expect(
        cells.every((cell) => cell === CELL.ground || cell === CELL.ink || cell === CELL.glint),
      ).toBe(true)
    }
    expect(seen).toEqual(new Set(['mirror', 'triple', 'quad']))
  })

  it('keeps orb and marble geometry inside the crop', () => {
    for (const name of NAMES.slice(0, 80)) {
      const orb = generatedAvatar(name, 'orb')
      if (orb.style !== 'orb') throw new Error('expected an orb')
      expect(orb.angle % 45).toBe(0)
      expect(orb.stops).toHaveLength(3)
      expect(orb.glow.x).toBeGreaterThan(0)
      expect(orb.glow.x).toBeLessThan(100)

      const marble = generatedAvatar(name, 'marble')
      if (marble.style !== 'marble') throw new Error('expected a marble')
      expect(marble.drops).toHaveLength(4)
      for (const drop of marble.drops) {
        expect(drop.x).toBeGreaterThanOrEqual(22)
        expect(drop.x).toBeLessThanOrEqual(78)
        expect(drop.r).toBeGreaterThanOrEqual(26)
        parts(drop.color)
      }
    }
  })

  it('spreads nearby names across distinct pictures in every style', () => {
    for (const style of AVATAR_STYLES) {
      const distinct = new Set(NAMES.map((name) => JSON.stringify(generatedAvatar(name, style))))
      expect(distinct.size, style).toBeGreaterThan(280)
    }
    expect(generatedAvatar('Leon')).not.toEqual(generatedAvatar('Leom'))
  })
})
