import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const markdownCss = readFileSync(new URL('./markdown.css', import.meta.url), 'utf8')

describe('code block rendering', () => {
  it('renders code blocks in full instead of a 200px placeholder', () => {
    // Streamdown puts `content-visibility: auto; contain-intrinsic-size: auto
    // 200px` inline on the wrapper. Only an !important rule overrides it, and
    // without the override a completing reply measures every block at 200px.
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] \{[^}]*content-visibility: visible !important;[^}]*contain-intrinsic-size: none !important;[^}]*\}/,
    )
  })

  it('keeps the formatting context the containment gave the block', () => {
    // Without it the inner block's margin collapses out of the wrapper and the
    // space below every code block shrinks by 14px.
    expect(markdownCss).toMatch(/\.md \[data-streamdown='code-block'\] \{[^}]*display: flow-root;/)
  })
})
