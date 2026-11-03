import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadWindowMaterial,
  parseWindowMaterial,
  saveWindowMaterial,
  SEE_THROUGH_BACKGROUND,
  windowBackdropOptions,
  windowBackgroundColor,
  windowMaterialSupport,
  type WindowMaterialSupport,
} from './window-material.js'

describe('windowMaterialSupport', () => {
  it.each([
    ['win32', '10.0.22621', 'material'],
    ['win32', '10.0.26200', 'material'],
    // Windows 11 21H2 and Windows 10 ignore backgroundMaterial.
    ['win32', '10.0.22000', 'none'],
    ['win32', '10.0.19045', 'none'],
    ['win32', '', 'none'],
    ['win32', 'garbage', 'none'],
    ['darwin', '15.1.0', 'vibrancy'],
    ['linux', '6.8.0', 'none'],
  ])('%s %s can draw %s', (platform, version, support) => {
    expect(windowMaterialSupport(platform, version)).toBe(support)
  })
})

describe('windowBackgroundColor', () => {
  it('clears the window only while the page shows what is behind it', () => {
    expect(SEE_THROUGH_BACKGROUND).toBe('#00000000')
    expect(windowBackgroundColor('#0f0f0f', true, 'material')).toBe(SEE_THROUGH_BACKGROUND)
    expect(windowBackgroundColor('#fdfdfd', true, 'vibrancy')).toBe(SEE_THROUGH_BACKGROUND)
  })

  it.each<WindowMaterialSupport>(['material', 'vibrancy', 'none'])(
    'keeps the opaque default (%s) when the page is not see-through',
    (support) => {
      expect(windowBackgroundColor('#0f0f0f', false, support)).toBe('#0f0f0f')
    },
  )

  it('never clears a window the OS draws nothing behind', () => {
    // Windows 10 and Linux would show a black or empty hole, not the desktop.
    expect(windowBackgroundColor('#202020', true, 'none')).toBe('#202020')
  })
})

describe('windowBackdropOptions', () => {
  it.each([
    ['win32', 'material', 'acrylic', { backgroundMaterial: 'acrylic' }],
    ['win32', 'material', 'mica', { backgroundMaterial: 'mica' }],
    // Windows 10 and Windows 11 21H2 draw no material; asking for one only
    // turned the window translucent for nothing.
    ['win32', 'none', 'acrylic', {}],
    ['darwin', 'vibrancy', 'acrylic', { vibrancy: 'sidebar' }],
    ['linux', 'none', 'acrylic', {}],
  ] as const)(
    '%s with %s and %s creates the window with %j',
    (platform, support, material, options) => {
      expect(windowBackdropOptions(platform, support, material)).toEqual(options)
    },
  )

  it('never makes a transparent window, which loses resizing on Windows', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const support of ['material', 'vibrancy', 'none'] as const) {
        expect(windowBackdropOptions(platform, support, 'acrylic')).not.toHaveProperty(
          'transparent',
        )
      }
    }
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    expect(main).not.toMatch(/\btransparent:\s*true/)
    expect(main).toContain(
      '...windowBackdropOptions(process.platform, materialSupport, windowMaterial),',
    )
    expect(main).toContain('backgroundColor: initialBackground,')
  })
})

describe('window material', () => {
  it('accepts only the two backdrops the renderer offers', () => {
    expect(parseWindowMaterial('acrylic')).toBe('acrylic')
    expect(parseWindowMaterial('mica')).toBe('mica')
    for (const value of ['tabbed', 'none', 'auto', '', undefined, 1, { material: 'mica' }]) {
      expect(() => parseWindowMaterial(value)).toThrow('Invalid window material')
    }
  })

  it('keeps the last material for the next launch and ignores a damaged file', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'window-material-'))
    try {
      const file = path.join(directory, 'nested', 'window-material.json')
      expect(loadWindowMaterial(file)).toBeUndefined()
      saveWindowMaterial(file, 'mica')
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ material: 'mica' })
      expect(loadWindowMaterial(file)).toBe('mica')
      writeFileSync(file, '{"material":"tabbed"}')
      expect(loadWindowMaterial(file)).toBeUndefined()
      writeFileSync(file, 'null')
      expect(loadWindowMaterial(file)).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
