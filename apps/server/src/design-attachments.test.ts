import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { designAttachedBeforeNote } from './design-attachments.js'

describe('designAttachedBeforeNote', () => {
  it('names images by a path the agent can open again after a compaction', () => {
    const workspace = path.join(os.tmpdir(), 'site')
    const outside = path.join(os.tmpdir(), 'capture', '1440x1000.jpg')
    expect(
      designAttachedBeforeNote([path.join(workspace, 'refs', 'hero.png'), outside], workspace),
    ).toBe(
      `These images were attached earlier in this chat and still apply unchanged; they are not attached again: ${path.join('refs', 'hero.png')}, ${outside}. If you no longer have them after a context compaction, open them from these paths.`,
    )
  })
})
