import { describe, expect, it } from 'vitest'
import { parseDiff } from './Diff.js'

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { start } from './server.js'
-start(3000)
+start(4311)
+console.log('up')
 `

describe('diff parsing', () => {
  it('counts additions and deletions without miscounting file headers', () => {
    // The trap: +++ and --- start with + and -, so a naive prefix check
    // reports every file as one extra addition and one extra deletion.
    const parsed = parseDiff(SAMPLE)
    expect(parsed.added).toBe(2)
    expect(parsed.removed).toBe(1)
    expect(parsed.files).toBe(1)
  })

  it('classifies each line', () => {
    const kinds = parseDiff(SAMPLE).lines.map((line) => line.kind)
    expect(kinds).toContain('meta')
    expect(kinds).toContain('hunk')
    expect(kinds).toContain('add')
    expect(kinds).toContain('del')
    expect(kinds).toContain('ctx')
  })

  it('counts multiple files', () => {
    const two = `${SAMPLE}\ndiff --git a/b.ts b/b.ts\n+x`
    expect(parseDiff(two).files).toBe(2)
  })
})
