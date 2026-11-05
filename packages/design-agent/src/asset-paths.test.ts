import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAssetPhaseOutput } from './asset-phase.js'
import { readAssetManifest } from './assets.js'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'design-asset-paths-'))
  made.push(dir)
  return dir
}

const manifest = (dir: string, destination: string) => ({
  version: 1,
  assets: [
    {
      id: 'hero_photo',
      kind: 'image',
      status: 'needed',
      purpose: 'Hero photograph.',
      requirements: [],
      destination,
    },
    {
      id: 'brand_font',
      kind: 'font',
      status: 'existing',
      purpose: 'Brand typeface.',
      requirements: [],
      source: { kind: 'project', reference: path.join(dir, 'assets', 'fonts', 'brand.woff2') },
    },
  ],
})

describe('asset paths', () => {
  // A real Codex run answered "E:\…\test30\.taste\hero_sourdough_photo.png" for a file it had
  // saved in the project, was told the destination must stay inside the workspace, and moved
  // the files by hand.
  it('reads an absolute path inside the workspace as the same project-relative file', () => {
    const dir = workspace()
    const parsed = parseAssetPhaseOutput(
      JSON.stringify(manifest(dir, path.join(dir, '.taste', 'hero.png'))),
      undefined,
      dir,
    )
    expect(parsed.assets[0]?.destination).toBe('.taste/hero.png')
    expect(parsed.assets[1]?.source?.reference).toBe('assets/fonts/brand.woff2')
  })

  it('still refuses a destination outside the workspace', () => {
    const dir = workspace()
    expect(() =>
      parseAssetPhaseOutput(
        JSON.stringify(manifest(dir, path.join(dir, '..', 'elsewhere.png'))),
        undefined,
        dir,
      ),
    ).toThrow(/destination must stay inside the workspace/)
  })

  it('treats an approved manifest whose paths were only written out in full as unchanged', () => {
    const dir = workspace()
    const approved = parseAssetPhaseOutput(
      JSON.stringify(manifest(dir, '.taste/hero.png')),
      undefined,
      dir,
    )
    mkdirSync(path.join(dir, '.taste'), { recursive: true })
    writeFileSync(
      path.join(dir, '.taste', 'assets.json'),
      JSON.stringify(manifest(dir, path.join(dir, '.taste', 'hero.png'))),
    )
    expect(readAssetManifest(dir)).toEqual(approved)
  })
})
