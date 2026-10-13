import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const markdownCss = readFileSync(new URL('./markdown.css', import.meta.url), 'utf8')
const largeCodeBlockSource = readFileSync(
  new URL('../ui/LargeCodeBlock.tsx', import.meta.url),
  'utf8',
)

describe('code block controls layout', () => {
  it('lifts the copy and download wrapper onto the language row instead of leaving a gap', () => {
    // Streamdown and LargeCodeBlock both wrap the controls in their own div
    // between the header and the body. In flow, that div kept the height of
    // the hidden buttons and opened a 24px hole under the language label.
    expect(largeCodeBlockSource).toMatch(
      /<CodeBlockHeader[^>]*\/>[\s\S]*?<div>\s*<div data-streamdown="code-block-actions">/,
    )
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] > div:has\(> \[data-streamdown='code-block-actions'\]\) \{[^}]*position: absolute;[^}]*top: 1px;[^}]*right: 2px;/s,
    )
  })
})
