import { describe, expect, it } from 'vitest'
import { parsePullRequestPatch } from './diff.js'

describe('parsePullRequestPatch', () => {
  it('tracks both sides across additions, deletions and context', () => {
    const [hunk] = parsePullRequestPatch(
      '@@ -10,3 +10,4 @@ function example() {\n unchanged\n-old\n+new\n+extra\n final\n\\ No newline at end of file',
    )

    expect(hunk?.header).toBe('@@ -10,3 +10,4 @@ function example() {')
    expect(hunk?.lines).toEqual([
      expect.objectContaining({ kind: 'context', oldLine: 10, newLine: 10, text: 'unchanged' }),
      expect.objectContaining({ kind: 'deletion', oldLine: 11, text: 'old' }),
      expect.objectContaining({ kind: 'addition', newLine: 11, text: 'new' }),
      expect.objectContaining({ kind: 'addition', newLine: 12, text: 'extra' }),
      expect.objectContaining({ kind: 'context', oldLine: 12, newLine: 13, text: 'final' }),
      expect.objectContaining({ kind: 'meta', text: '\\ No newline at end of file' }),
    ])
    expect(hunk?.lines[1]).not.toHaveProperty('newLine')
    expect(hunk?.lines[2]).not.toHaveProperty('oldLine')
  })

  it('returns no hunks for a binary or omitted patch', () => {
    expect(parsePullRequestPatch('')).toEqual([])
    expect(parsePullRequestPatch('Binary files differ')).toEqual([])
  })
})
