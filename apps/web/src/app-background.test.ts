// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_BACKGROUND_BLUR_KEY,
  APP_BACKGROUND_DIM_KEY,
  APP_BACKGROUND_EFFECT_KEY,
  APP_BACKGROUND_IMAGE_KEY,
  APP_BACKGROUND_KEY,
  APP_BACKGROUND_MATERIAL_KEY,
  dimFactor,
  nextImageRevision,
  parseAppBackground,
  readAppBackground,
  resetAppBackgroundForTests,
  subscribeAppBackground,
  windowMaterialSupport,
  writeAppBackground,
} from './app-background.js'
import {
  backgroundImageProblem,
  DISPLAY_IMAGE_BLUR,
  DISPLAY_IMAGE_VERSION,
  displayImageVersion,
  fitWithin,
  MAX_BACKGROUND_IMAGE_BYTES,
} from './app-background-image.js'

afterEach(() => {
  localStorage.clear()
  resetAppBackgroundForTests()
  vi.restoreAllMocks()
})

describe('window background preference', () => {
  it('defaults to None, so nothing changes until someone picks', () => {
    expect(readAppBackground()).toEqual({
      mode: 'none',
      effect: 'dither',
      material: 'acrylic',
      image: undefined,
      dim: 50,
      blur: 14,
    })
  })

  it.each([
    [{ mode: 'video', effect: 'snow', material: 'tabbed', image: '../x', dim: '-1', blur: '41' }],
    [{ mode: '', effect: '', material: '', image: '', dim: '', blur: '' }],
    [{ mode: 'IMAGE', effect: 'Glow', material: 'Mica', image: 'a'.repeat(65), dim: '101' }],
    [{ mode: null, effect: null, material: null, image: null, dim: '4.5', blur: '1e1' }],
  ])('turns garbage into the defaults %j', (values) => {
    expect(parseAppBackground(values)).toEqual({
      mode: 'none',
      effect: 'dither',
      material: 'acrylic',
      image: undefined,
      dim: 50,
      blur: 14,
    })
  })

  it('reads what was stored', () => {
    localStorage.setItem(APP_BACKGROUND_KEY, 'effect')
    localStorage.setItem(APP_BACKGROUND_EFFECT_KEY, 'halftone')
    localStorage.setItem(APP_BACKGROUND_MATERIAL_KEY, 'mica')
    localStorage.setItem(APP_BACKGROUND_IMAGE_KEY, 'lr2k1x-0a1b')
    localStorage.setItem(APP_BACKGROUND_DIM_KEY, '0')
    localStorage.setItem(APP_BACKGROUND_BLUR_KEY, '40')
    expect(readAppBackground()).toEqual({
      mode: 'effect',
      effect: 'halftone',
      material: 'mica',
      image: 'lr2k1x-0a1b',
      dim: 0,
      blur: 40,
    })
  })

  it.each(['glow', 'aurora'])('moves a stored %s, which was removed, to Dither', (retired) => {
    localStorage.setItem(APP_BACKGROUND_KEY, 'effect')
    localStorage.setItem(APP_BACKGROUND_EFFECT_KEY, retired)
    expect(readAppBackground()).toMatchObject({ mode: 'effect', effect: 'dither' })
    expect(localStorage.getItem(APP_BACKGROUND_EFFECT_KEY)).toBe('dither')
  })

  it('keeps one snapshot until a write, then persists only what changed and notifies', () => {
    const first = readAppBackground()
    expect(readAppBackground()).toBe(first)
    const listener = vi.fn()
    const unsubscribe = subscribeAppBackground(listener)
    const setItem = vi.spyOn(localStorage, 'setItem')

    writeAppBackground({ mode: 'image', image: 'rev-1' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(readAppBackground()).not.toBe(first)
    expect(readAppBackground()).toMatchObject({ mode: 'image', image: 'rev-1' })
    expect(setItem.mock.calls.map(([key]) => key).sort()).toEqual(
      [APP_BACKGROUND_KEY, APP_BACKGROUND_IMAGE_KEY].sort(),
    )

    const unchanged = readAppBackground()
    writeAppBackground({ mode: 'image' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(readAppBackground()).toBe(unchanged)

    writeAppBackground({ image: undefined })
    expect(localStorage.getItem(APP_BACKGROUND_IMAGE_KEY)).toBeNull()
    unsubscribe()
    writeAppBackground({ mode: 'none' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stores Dim and Blur as whole numbers inside their range', () => {
    writeAppBackground({ dim: 72.6, blur: 3 })
    expect(readAppBackground()).toMatchObject({ dim: 73, blur: 3 })
    expect(localStorage.getItem(APP_BACKGROUND_DIM_KEY)).toBe('73')
    expect(localStorage.getItem(APP_BACKGROUND_BLUR_KEY)).toBe('3')
    writeAppBackground({ dim: 500, blur: -2 })
    expect(readAppBackground()).toMatchObject({ dim: 100, blur: 0 })
    writeAppBackground({ dim: Number.NaN })
    expect(readAppBackground().dim).toBe(0)
  })

  it('turns Dim into a factor of the dim the window always had', () => {
    expect(dimFactor(50)).toBe('1')
    expect(dimFactor(0)).toBe('0')
    expect(dimFactor(100)).toBe('2')
  })

  it('still works for the session when storage is blocked', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(readAppBackground().mode).toBe('none')
    writeAppBackground({ mode: 'effect', effect: 'grain' })
    expect(readAppBackground()).toMatchObject({ mode: 'effect', effect: 'grain' })
    resetAppBackgroundForTests()
    // The session copy is gone with the reset, the way a reload would lose it.
    expect(readAppBackground().mode).toBe('none')
  })

  it('knows a browser cannot draw behind its page', () => {
    expect(windowMaterialSupport()).toBe('none')
  })

  it('makes image revisions that are safe to store and differ', () => {
    const first = nextImageRevision(1_700_000_000_000)
    const second = nextImageRevision(1_700_000_000_001)
    expect(first).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(first).not.toBe(second)
    expect(
      parseAppBackground({ mode: 'image', effect: null, material: null, image: first }).image,
    ).toBe(first)
  })
})

describe('background image checks', () => {
  it('accepts common raster images and refuses everything else', () => {
    expect(backgroundImageProblem({ type: 'image/jpeg', size: 1_000 })).toBeUndefined()
    expect(backgroundImageProblem({ type: 'image/webp', size: 1_000 })).toBeUndefined()
    // SVG can carry script and links; a background never needs it.
    expect(backgroundImageProblem({ type: 'image/svg+xml', size: 1_000 })).toMatch(/PNG, JPEG/)
    expect(backgroundImageProblem({ type: 'text/html', size: 1_000 })).toMatch(/PNG, JPEG/)
    expect(backgroundImageProblem({ type: '', size: 1_000 })).toMatch(/PNG, JPEG/)
    expect(
      backgroundImageProblem({ type: 'image/png', size: MAX_BACKGROUND_IMAGE_BYTES + 1 }),
    ).toMatch(/under 40 MB/)
    expect(backgroundImageProblem({ type: 'image/png', size: 0 })).toMatch(/empty/)
  })

  it('keeps the display copies made before Blur existed', () => {
    expect(readAppBackground().blur).toBe(DISPLAY_IMAGE_BLUR)
    expect(DISPLAY_IMAGE_VERSION).toBe('blur14@1600')
    expect(displayImageVersion(0)).toBe('blur0@1600')
  })

  it('shrinks to fit the longest edge and never enlarges', () => {
    expect(fitWithin(6000, 4000, 2560)).toEqual({ width: 2560, height: 1707 })
    expect(fitWithin(1080, 1920, 1600)).toEqual({ width: 900, height: 1600 })
    expect(fitWithin(800, 600, 2560)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(0, 0, 2560)).toEqual({ width: 1, height: 1 })
  })
})
