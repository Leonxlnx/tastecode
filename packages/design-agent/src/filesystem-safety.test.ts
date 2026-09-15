import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readDesignArtifact, writeDesignArtifact } from './artifact-store.js'
import {
  snapshotDesignAssets,
  snapshotDesignFiles,
  validateDesignFileSnapshot,
} from './file-snapshot.js'
import {
  containedWorkspaceFile,
  normalizeWorkspaceFile,
  readWorkspaceFile,
  workspaceEntries,
} from './workspace-files.js'

const roots: string[] = []
function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-design-files-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Design filesystem boundaries', () => {
  it('writes and restores artifacts without following an artifact symlink', () => {
    const root = workspace()
    const outside = workspace()
    const unrelated = path.join(outside, 'untouched.json')
    writeFileSync(unrelated, 'keep me')
    mkdirSync(path.join(root, '.taste'))
    symlinkSync(unrelated, path.join(root, '.taste', 'brief.json'))
    expect(() => readDesignArtifact(root, 'brief.json')).toThrow('regular file')
    writeDesignArtifact(root, 'brief.json', { approved: true })
    expect(readDesignArtifact(root, 'brief.json')).toEqual({ approved: true })
    expect(readFileSync(unrelated, 'utf8')).toBe('keep me')
  })

  it('rejects an artifact directory symlink before writing outside the workspace', () => {
    const root = workspace()
    const outside = workspace()
    symlinkSync(outside, path.join(root, '.taste'), 'junction')
    expect(() => writeDesignArtifact(root, 'brief.json', {})).toThrow('real directory')
    expect(workspaceEntries(outside)).toEqual([])
  })

  it('rejects escapes, Windows alternate streams, and symlink targets outside the workspace', () => {
    for (const unsafe of [
      '../secret',
      'a/../secret',
      'C:\\secret.txt',
      '/secret',
      'a.txt:stream',
      'a\0.txt',
    ]) {
      expect(normalizeWorkspaceFile(unsafe)).toBeUndefined()
    }
    const root = workspace()
    const outside = workspace()
    writeFileSync(path.join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, path.join(root, 'linked'), 'junction')
    expect(() => containedWorkspaceFile(root, 'linked/secret.txt', 'asset')).toThrow(
      'after resolving symlinks',
    )
    expect(workspaceEntries(root)).toEqual([{ relative: 'linked', file: false }])
  })

  it('bounds reads and rejects a reference that changes without changing its size', () => {
    const file = path.join(workspace(), 'reference.png')
    writeFileSync(file, 'original')
    const snapshot = snapshotDesignFiles([file])
    validateDesignFileSnapshot(snapshot)
    writeFileSync(file, 'modified')
    expect(() => validateDesignFileSnapshot(snapshot)).toThrow('changed after approval')
    truncateSync(file, 32_000_001)
    expect(() => snapshotDesignFiles([file])).toThrow('exceeds 32000000 bytes')
    expect(() => readWorkspaceFile(file, 2_000_000)).toThrow('exceeds 2000000 bytes')
  })

  it('tracks the current target of approved asset links and leaves native components editable', () => {
    const root = workspace()
    writeFileSync(path.join(root, 'one.svg'), '<svg id="one" />')
    writeFileSync(path.join(root, 'two.svg'), '<svg id="two" />')
    const link = path.join(root, 'logo.svg')
    symlinkSync(path.join(root, 'one.svg'), link)
    const manifest = {
      version: 1 as const,
      assets: [
        {
          id: 'logo',
          kind: 'icon' as const,
          status: 'ready' as const,
          purpose: 'Logo',
          requirements: [],
          role: 'logo' as const,
          source: { kind: 'project' as const, reference: 'one.svg' },
          destination: 'logo.svg',
        },
      ],
    }
    const snapshot = snapshotDesignAssets(root, manifest)
    rmSync(link)
    symlinkSync(path.join(root, 'two.svg'), link)
    expect(snapshotDesignAssets(root, manifest)).not.toEqual(snapshot)
    expect(
      snapshotDesignAssets(root, {
        version: 1,
        assets: [{ ...manifest.assets[0]!, kind: 'component', role: 'component' }],
      }),
    ).toEqual([])
  })

  it('fails on excessive nesting instead of skipping files', () => {
    const root = workspace()
    mkdirSync(path.join(root, ...Array.from({ length: 42 }, () => 'a')), { recursive: true })
    expect(() => workspaceEntries(root)).toThrow('exceeds 40 directory levels')
  })
})
