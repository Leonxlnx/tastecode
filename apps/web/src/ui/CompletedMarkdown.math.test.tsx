// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import { needsRichMarkdown } from './Markdown.js'

afterEach(cleanup)

describe('math in a finished reply', () => {
  it('renders \\( \\), \\[ \\], $ and $$ formulas with KaTeX', () => {
    const view = render(
      <CompletedMarkdown
        text={
          'Inline \\(a^2 + b^2 = c^2\\) and $x_i$.\n\n\\[\n17^{23} \\bmod 97 = 7\n\\]\n\n$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$'
        }
      />,
    )
    expect(view.container.querySelectorAll('.katex')).toHaveLength(4)
    expect(view.container.querySelectorAll('.katex-display')).toHaveLength(2)
    expect(view.container.textContent).not.toContain('\\(')
    expect(view.container.textContent).not.toContain('\\[')
  })

  it('keeps prices as text', () => {
    const view = render(<CompletedMarkdown text={'It costs **$5** and $10 per month.'} />)
    expect(view.container.querySelector('.katex')).toBeNull()
    expect(view.container.textContent).toContain('$5 and $10')
  })

  it('shows a formula KaTeX cannot parse as its source', () => {
    const view = render(<CompletedMarkdown text={'Broken \\(\\frac{1}{\\)'} />)
    expect(view.container.textContent).toContain('\\frac{1}{')
  })

  it('sends dollar-only math to the full renderer', () => {
    expect(needsRichMarkdown('Let $x$ be one')).toBe(true)
    expect(needsRichMarkdown('It costs $5 and $10.')).toBe(false)
  })
})
