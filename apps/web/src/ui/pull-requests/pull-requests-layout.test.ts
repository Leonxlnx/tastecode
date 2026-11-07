import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./pull-requests.css', import.meta.url), 'utf8')

describe('pull request detail layout', () => {
  it('keeps the detail and its facts to one column no wider than the pane', () => {
    // An implicit auto column takes its widest item's minimum: the toolbar, or a branch name.
    expect(css).toMatch(/\.pr-detail \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s)
    expect(css).toMatch(/\.pr-facts \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s)
  })

  it('wraps the toolbar actions and long fact values instead of overflowing', () => {
    expect(css).toMatch(/\.pr-detail-toolbar \{[^}]*flex-wrap: wrap;/s)
    expect(css).toMatch(/\.pr-detail-actions \{[^}]*flex-wrap: wrap;/s)
    expect(css).toMatch(/\.pr-fact-content \{[^}]*overflow-wrap: anywhere;/s)
  })
})
