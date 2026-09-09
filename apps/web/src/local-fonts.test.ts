// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listInstalledFontFamilies } from './local-fonts.js'

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'queryLocalFonts')
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

    await expect(listInstalledFontFamilies()).resolves.toEqual([
      'Atkinson Hyperlegible',
      'Zilla Slab',
    ])
  })

  it('degrades when enumeration is unavailable or denied', async () => {
    await expect(listInstalledFontFamilies()).resolves.toEqual([])

    Object.defineProperty(globalThis, 'queryLocalFonts', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new DOMException('Denied')),
    })
    await expect(listInstalledFontFamilies()).resolves.toEqual([])
  })
})
