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
      /\.md \[data-streamdown='code-block'\] > div:has\(> \[data-streamdown='code-block-actions'\]\) \{[^}]*position: absolute;[^}]*top: 2px;[^}]*right: -6\.5px;/s,
    )
  })

  it('centres the controls on the label row and ends them on the block edge', () => {
    // A 26px row put the 24px buttons 1px above the block's border, so they
    // read as tabs on the block while the label floated beside them. 28px
    // buttons sit 2px into a 32px row.
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block-header'\] \{[^}]*height: 32px;[^}]*padding: 0 96px 0 0;[^}]*line-height: 32px;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s,
    )
  })

  it('draws the controls as ghost icon buttons like the reply actions', () => {
    const button = /\.md \[data-streamdown='code-block'\] button \{([^}]*)\}/.exec(markdownCss)?.[1]
    expect(button).toMatch(/width: 28px;[^}]*height: 28px;/s)
    expect(button).toContain('background: transparent;')
    expect(button).toContain('border: 0;')
    // Opacity and transition on a button lose to the button-feedback layer.
    expect(button).not.toContain('opacity')
    expect(button).not.toContain('transition')
    expect(markdownCss).not.toContain("[data-streamdown='code-block'] button::before")
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] button:hover,\s*\.md \[data-streamdown='code-block'\] button:focus-visible \{[^}]*background: var\(--surface\);[^}]*color: var\(--text-2\);/s,
    )
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] button svg \{[^}]*width: 15px;[^}]*height: 15px;[^}]*stroke-width: 1\.7;/s,
    )
    expect(largeCodeBlockSource).toContain('<TextWrap size={15} aria-hidden />')
  })

  it('fades the whole action row in on block hover or focus', () => {
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] > div:has\(> \[data-streamdown='code-block-actions'\]\) \{[^}]*opacity: 0;[^}]*transition: opacity var\(--dur-hover\) var\(--ease-out\);/s,
    )
    // Keyboard focus on any one button reveals all of them.
    expect(markdownCss).toMatch(
      /\[data-streamdown='code-block'\]:is\(:hover, :focus-within\)\s*> div:has\(> \[data-streamdown='code-block-actions'\]\) \{\s*opacity: 1;/s,
    )
    expect(markdownCss).toMatch(
      /@media \(hover: none\) \{\s*\.md \[data-streamdown='code-block'\] > div:has\(> \[data-streamdown='code-block-actions'\]\) \{\s*opacity: 1;/s,
    )
  })

  it('drops Download before the row can run into the label', () => {
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] \{\s*container: code-block \/ inline-size;\s*\}/,
    )
    expect(markdownCss).toMatch(
      /@container code-block \(max-width: 360px\) \{\s*\.md \[data-streamdown='code-block'\] button\[data-streamdown='code-block-download-button'\] \{\s*display: none;/s,
    )
  })

  it('labels a fence without a language as text, completed or live', () => {
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block-header'\] > span:empty::before,\s*\.md \[data-streamdown='code-block-header'\]:empty::before \{\s*content: 'text';\s*\}/,
    )
  })

  it('wraps code through white-space on the root choice', () => {
    expect(markdownCss).toMatch(
      /:root\[data-code-wrap='on'\] \.md pre code \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/s,
    )
  })

  it('shows a pressed Wrap toggle', () => {
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] button\[aria-pressed='true'\] \{[^}]*background: var\(--control-pressed\);[^}]*color: var\(--text\);/s,
    )
  })
})
