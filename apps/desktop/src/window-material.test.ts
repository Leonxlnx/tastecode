import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadWindowMaterial,
  parseWindowMaterial,
  saveWindowMaterial,
  windowMaterialSupport,
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
