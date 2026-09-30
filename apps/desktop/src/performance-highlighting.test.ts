// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { highlightedTokens } from '../scripts/performance/highlighting-dom.js'

it('does not mistake Streamdown fallback spans for real worker highlighting', () => {
  const host = document.createElement('section')
  host.innerHTML = '<code><span style="--sdm-c: inherit">plain fallback</span></code>'
  expect(highlightedTokens(host)).toHaveLength(0)
  host.querySelector('code')!.innerHTML =
    '<span style="--sdm-c: #cf222e; --shiki-dark: #ff7b72">export</span>'
  expect(highlightedTokens(host)).toHaveLength(1)
  host.querySelector('code')!.replaceChildren()
  expect(highlightedTokens(host)).toHaveLength(0)
})
