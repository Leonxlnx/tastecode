import { describe, expect, it } from 'vitest'
import { parsePatchFiles } from '@pierre/diffs'
import type { PullRequestFile } from '@harness/contracts'
import { pullRequestFilePatch } from './diffs-patch.js'

function file(overrides: Partial<PullRequestFile> = {}): PullRequestFile {
  return {
    sha: 'abc123',
    path: 'src/card.tsx',
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@ -1 +1 @@\n-old\n+new',
    ...overrides,
  }
}

describe('pullRequestFilePatch', () => {
  it('adds unified file headers to GitHub patch fragments', () => {
    expect(pullRequestFilePatch(file())).toBe(
      '--- src/card.tsx\n+++ src/card.tsx\n@@ -1 +1 @@\n-old\n+new',
    )
  })

  it('preserves rename and added-file identities for Diffs', () => {
    expect(
      pullRequestFilePatch(file({ previousPath: 'src/old.tsx', path: 'src/new.tsx' })),
    ).toContain('--- src/old.tsx\n+++ src/new.tsx')
    expect(pullRequestFilePatch(file({ status: 'added' }))).toContain(
      '--- /dev/null\n+++ src/card.tsx',
    )
  })

  it('produces a single file and hunk accepted by Diffs', () => {
    const parsed = parsePatchFiles(pullRequestFilePatch(file()), 'test', true)

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.files).toHaveLength(1)
    expect(parsed[0]?.files[0]).toMatchObject({
      name: 'src/card.tsx',
      type: 'change',
      hunks: [expect.objectContaining({ deletionStart: 1, additionStart: 1 })],
    })
  })
})
