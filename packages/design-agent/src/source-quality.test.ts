import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { designSourceQualityBaseline, validateDesignSourceQuality } from './source-quality.js'

const roots: string[] = []

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-design-source-size-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('design source scan size limits', () => {
  it('accepts large HTML with embedded images during baseline and validation', () => {
    const root = workspace()
    const file = 'comparison-mobile.html'
    const source = `<img src="data:image/png;base64,${'A'.repeat(2_100_000)}">`
    writeFileSync(path.join(root, file), source)

    const baseline = designSourceQualityBaseline(root)
    expect(baseline).toEqual([])
    expect(() => validateDesignSourceQuality(root, [file], baseline)).not.toThrow()

    writeFileSync(
      path.join(root, file),
      `${source}<style>.feature-card { border-left: 3px solid red; }</style><svg></svg>`,
    )
    expect(() => validateDesignSourceQuality(root, [file], baseline)).toThrow(
      'one-sided card-edge border',
    )
    expect(() => validateDesignSourceQuality(root, [file], baseline)).toThrow(
      'unmanifested inline SVG substitute',
    )
  })

  it('accepts a source file at the 32 MB scan limit', () => {
    const root = workspace()
    const file = path.join(root, 'index.html')
    writeFileSync(file, '')
    truncateSync(file, 32_000_000)
    expect(designSourceQualityBaseline(root)).toEqual([])
  })

  it('rejects a file over the scan limit before reading it', () => {
    const root = workspace()
    const file = path.join(root, 'index.html')
    writeFileSync(file, '')
    truncateSync(file, 32_000_001)
    expect(() => designSourceQualityBaseline(root)).toThrow('exceeds 32000000 bytes')
  })

  it('keeps the total source scan bounded across large files', () => {
    const root = workspace()
    for (const name of ['desktop.html', 'mobile.html']) {
      const file = path.join(root, name)
      writeFileSync(file, '')
      truncateSync(file, 16_000_001)
    }
    expect(() => designSourceQualityBaseline(root)).toThrow('Design source scan exceeds 32 MB')
  })
})
