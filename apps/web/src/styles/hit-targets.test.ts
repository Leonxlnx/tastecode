import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const threadCss = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')
const markdownCss = readFileSync(new URL('./markdown.css', import.meta.url), 'utf8')
const updateCss = readFileSync(new URL('./provider-update-notice.css', import.meta.url), 'utf8')

describe('hit targets', () => {
  it('reaches 28px on the 24px prompt actions without growing their strip', () => {
    expect(threadCss).toMatch(
      /\.response-actions\.said__actions button \{[^}]*position: relative;[^}]*width: 24px;[^}]*height: 24px;/s,
    )
    expect(threadCss).toMatch(
      /\.response-actions\.said__actions button::before \{[^}]*content: '';[^}]*position: absolute;[^}]*inset: -2px;/s,
    )
  })

  it('reaches 28px on code block and table controls', () => {
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] button \{[^}]*position: relative;[^}]*width: 24px;/s,
    )
    expect(markdownCss).toMatch(
      /\.md \[data-streamdown='code-block'\] button::before \{[^}]*position: absolute;[^}]*inset: -2px;/s,
    )
    expect(markdownCss).toMatch(
      /> div > button \{[^}]*&::before \{[^}]*position: absolute;[^}]*inset: -2px;/s,
    )
  })

  it('gives the provider update dismiss button a 28px target', () => {
    expect(updateCss).toMatch(
      /\.update-slip__head > button \{[^}]*width: 28px;[^}]*height: 28px;[^}]*margin-right: -2px;/s,
    )
  })
})
