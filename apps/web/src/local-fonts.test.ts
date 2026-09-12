// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CACHE_KEY = 'harness.installed-font-families.v1'
let fonts: typeof import('./local-fonts.js')

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  fonts = await import('./local-fonts.js')
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'queryLocalFonts')
  vi.restoreAllMocks()
})

describe('installed font families', () => {
  it('deduplicates faces and sorts valid family names', async () => {
    Object.defineProperty(globalThis, 'queryLocalFonts', {
      configurable: true,
      value: vi
        .fn()
        .mockResolvedValue([
          { family: 'Zilla Slab', fullName: 'Zilla Slab Bold' },
          { family: 'Atkinson Hyperlegible', fullName: 'Atkinson Hyperlegible Regular' },
          { family: 'Zilla Slab', fullName: 'Zilla Slab Regular' },
          { family: '  Atkinson Hyperlegible  ', fullName: 'Atkinson Hyperlegible Bold' },
          { family: '' },
          { family: 'Broken\nFamily' },
          { family: 42 },
        ]),
    })

    await expect(fonts.listInstalledFontFamilies()).resolves.toEqual([
      'Atkinson Hyperlegible',
      'Zilla Slab',
    ])
  })

  it('degrades when enumeration is unavailable or denied', async () => {
    await expect(fonts.listInstalledFontFamilies()).resolves.toEqual([])

    Object.defineProperty(globalThis, 'queryLocalFonts', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new DOMException('Denied')),
    })
    await expect(fonts.listInstalledFontFamilies()).resolves.toEqual([])
    expect(localStorage.getItem(CACHE_KEY)).toBeNull()
  })

  it('shares a pending scan and restores the complete list after a reload', async () => {
    let complete!: (records: unknown) => void
    const query = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    Object.defineProperty(globalThis, 'queryLocalFonts', { configurable: true, value: query })

    expect(fonts.readInstalledFontFamilies()).toBeUndefined()
    const first = fonts.listInstalledFontFamilies()
    const second = fonts.listInstalledFontFamilies()
    expect(query).toHaveBeenCalledOnce()
    expect(fonts.readInstalledFontFamilies()).toBeUndefined()
    complete([{ family: 'Zilla Slab' }, { family: 'Atkinson Hyperlegible' }])
    const families = ['Atkinson Hyperlegible', 'Zilla Slab']
    await expect(first).resolves.toEqual(families)
    await expect(second).resolves.toEqual(families)
    await expect(fonts.listInstalledFontFamilies()).resolves.toEqual(families)
    vi.resetModules()
    const reloaded = await import('./local-fonts.js')
    expect(reloaded.readInstalledFontFamilies()).toEqual(families)
    await expect(reloaded.listInstalledFontFamilies()).resolves.toEqual(families)
    expect(query).toHaveBeenCalledOnce()
  })

  it('keeps the complete stale list until refresh finishes and retries a failed refresh', async () => {
    const oldCache = JSON.stringify({ savedAt: Date.now() - 86_400_001, families: ['Old Font'] })
    localStorage.setItem(CACHE_KEY, oldCache)
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce([{ family: 'New Font' }])
    Object.defineProperty(globalThis, 'queryLocalFonts', { configurable: true, value: query })

    expect(fonts.readInstalledFontFamilies()).toEqual(['Old Font'])
    await expect(fonts.listInstalledFontFamilies()).resolves.toEqual(['Old Font'])
    expect(localStorage.getItem(CACHE_KEY)).toBe(oldCache)
    const refreshed = fonts.listInstalledFontFamilies()
    expect(fonts.readInstalledFontFamilies()).toEqual(['Old Font'])
    await expect(refreshed).resolves.toEqual(['New Font'])
    expect(fonts.readInstalledFontFamilies()).toEqual(['New Font'])
    expect(query).toHaveBeenCalledTimes(2)
  })

  it.each([
    '{',
    '{"families":[]}',
    JSON.stringify({ savedAt: 1, families: [42] }),
    JSON.stringify({ savedAt: 1, families: ['Broken\nFamily'] }),
    JSON.stringify({ savedAt: Number.MAX_SAFE_INTEGER, families: ['Future Font'] }),
  ])('ignores a broken cache: %s', async (cache) => {
    localStorage.setItem(CACHE_KEY, cache)
    const query = vi.fn().mockResolvedValue([{ family: 'Valid Font' }])
    Object.defineProperty(globalThis, 'queryLocalFonts', { configurable: true, value: query })
    expect(fonts.readInstalledFontFamilies()).toBeUndefined()
    await expect(fonts.listInstalledFontFamilies()).resolves.toEqual(['Valid Font'])
    expect(query).toHaveBeenCalledOnce()
  })

  it.each(['getItem', 'setItem'] as const)(
    'keeps a session cache when storage %s fails',
    async (method) => {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('Storage blocked')
      })
      const query = vi.fn().mockResolvedValue([{ family: 'Cached Font' }])
      Object.defineProperty(globalThis, 'queryLocalFonts', { configurable: true, value: query })
      await expect(fonts.listInstalledFontFamilies()).resolves.toEqual(['Cached Font'])
      expect(fonts.readInstalledFontFamilies()).toEqual(['Cached Font'])
      await expect(fonts.listInstalledFontFamilies()).resolves.toEqual(['Cached Font'])
      expect(query).toHaveBeenCalledOnce()
    },
  )

  it('caches a successful empty list but retries malformed scan results', async () => {
    const query = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([])
    Object.defineProperty(globalThis, 'queryLocalFonts', { configurable: true, value: query })
    await fonts.listInstalledFontFamilies()
    expect(localStorage.getItem(CACHE_KEY)).toBeNull()
    await fonts.listInstalledFontFamilies()
    expect(fonts.readInstalledFontFamilies()).toEqual([])
    await fonts.listInstalledFontFamilies()
    expect(query).toHaveBeenCalledTimes(2)
  })
})
