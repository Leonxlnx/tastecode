// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { highlightedTokens, highlightingReady } from '../scripts/performance/highlighting-dom.js'

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

it('waits for every duplicate fence and its final token batch', () => {
  const host = document.createElement('section')
  const token = '<span style="--sdm-c: #cf222e; --shiki-dark: #ff7b72">export</span>'
  host.innerHTML = `<pre><code>${token}</code></pre><pre><code>plain second fence</code></pre>`
  expect(highlightedTokens(host)).toHaveLength(1)
  expect(highlightingReady(host, 2)).toBe(false)
  host.querySelectorAll('code')[1]!.innerHTML = token
  host.querySelectorAll('pre')[1]!.setAttribute('data-highlight-pending', 'true')
  expect(highlightingReady(host, 2)).toBe(false)
  host.querySelectorAll('pre')[1]!.removeAttribute('data-highlight-pending')
  expect(highlightingReady(host, 2)).toBe(true)
  expect(highlightingReady(host, 1)).toBe(false)
})
