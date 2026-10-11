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

  it.each([
    { name: 'U+2028', separator: '\u2028' },
    { name: 'U+2029', separator: '\u2029' },
  ])('numbers a hunk whose header context contains $name', ({ separator }) => {
    const hunks = parsePullRequestPatch(
      `@@ -1 +1 @@\n-a\n+b\n@@ -20,1 +30,1 @@ const text = "${separator}"\n-old\n+new`,
    )

    expect(hunks.map((hunk) => hunk.header)).toEqual([
      '@@ -1 +1 @@',
      `@@ -20,1 +30,1 @@ const text = "${separator}"`,
    ])
    expect(hunks[1]?.lines).toEqual([
      expect.objectContaining({ kind: 'deletion', oldLine: 20, text: 'old' }),
      expect.objectContaining({ kind: 'addition', newLine: 30, text: 'new' }),
    ])
  })

  it('returns no hunks for a binary or omitted patch', () => {
    expect(parsePullRequestPatch('')).toEqual([])
    expect(parsePullRequestPatch('Binary files differ')).toEqual([])
  })
})
