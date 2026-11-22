import { describe, expect, it } from 'vitest'
import { splitAttachedFilePaths, withAttachedFilePaths } from './attached-files.js'

describe('the file paths at the end of a saved Claude prompt', () => {
  it('reads back the files a prompt was sent with', () => {
    const files = ['/work/notes.md', 'C:\\work\\plan.txt']
    expect(splitAttachedFilePaths(withAttachedFilePaths('Look at these', files))).toEqual({
      text: 'Look at these',
      files,
    })
  })

  it('leaves the user’s own text whole when it only looks like the list', () => {
    const text = 'Use this exact sample in the README:\n\nAttached file paths:\n- "docs/example.md"'
    expect(splitAttachedFilePaths(text)).toEqual({ text, files: [] })
  })
})
