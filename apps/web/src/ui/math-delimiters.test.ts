import { describe, expect, it } from 'vitest'
import { mayHaveDollarMath, normalizeMathDelimiters } from './math-delimiters.js'

describe('normalizeMathDelimiters', () => {
  it('turns \\( \\) into inline $$ math', () => {
    expect(normalizeMathDelimiters('where \\(n\\) is the count and \\( a^2 + b^2 \\) holds')).toBe(
      'where $$n$$ is the count and $$a^2 + b^2$$ holds',
    )
  })

  it('turns \\[ \\] into a display fence on its own lines', () => {
    expect(normalizeMathDelimiters('So\n\\[\n17^{23} \\bmod 97 = 7\n\\]\nDone.')).toBe(
      'So\n\n$$\n17^{23} \\bmod 97 = 7\n$$\n\n\nDone.',
    )
  })

  it('keeps a display formula inside its list item', () => {
    expect(normalizeMathDelimiters('- Step:\n  \\[ x = \\frac{1}{2} \\]\n')).toBe(
      '- Step:\n  \n  $$\n  x = \\frac{1}{2}\n  $$\n\n\n',
    )
  })

  it('reads $x$ as math the way Pandoc does', () => {
    expect(normalizeMathDelimiters('Let $x$ be $x_i^2 + 1$.')).toBe('Let $$x$$ be $$x_i^2 + 1$$.')
  })

  it('leaves prices, shell variables and escaped dollars as text', () => {
    for (const text of [
      'It costs $5 and $10 per month.',
      'Between $5-$10.',
      'US$5 or US$10',
      'Run echo $HOME and $PATH',
      'A literal \\$x\\$ stays.',
      'See \\[1\\] and \\[2\\].',
    ])
      expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('leaves code untouched', () => {
    const text = 'Inline `\\(x\\)` and `$y$`.\n\n```tex\n\\[ a = b \\]\n$z$\n```\nAfter \\(c\\)'
    expect(normalizeMathDelimiters(text)).toBe(
      'Inline `\\(x\\)` and `$y$`.\n\n```tex\n\\[ a = b \\]\n$z$\n```\nAfter $$c$$',
    )
  })

  it('returns the same string when there is nothing to rewrite', () => {
    const text = 'Plain words only.'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })
})

describe('mayHaveDollarMath', () => {
  it('spots dollar math but not prices', () => {
    expect(mayHaveDollarMath('$$E = mc^2$$')).toBe(true)
    expect(mayHaveDollarMath('Let $x$ be one')).toBe(true)
    expect(mayHaveDollarMath('It costs $5 and $10.')).toBe(false)
    expect(mayHaveDollarMath('no dollars')).toBe(false)
  })
})
