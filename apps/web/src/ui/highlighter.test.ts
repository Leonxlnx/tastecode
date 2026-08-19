import { describe, expect, it } from 'vitest'
import { DARK_THEME, LIGHT_THEME } from './highlighter-config.js'
import { onHighlighterChange, shikiPlugin, warmHighlighter } from './highlighter.js'

describe('syntax highlighter loading', () => {
  it('keeps plain code readable while the heavy runtime warms in a separate chunk', async () => {
    const code = 'const answer: number = 42'
    const options = {
      code,
      language: 'typescript',
      themes: [LIGHT_THEME, DARK_THEME],
    } as const
    const ready = new Promise<void>((resolve) => {
      const off = onHighlighterChange(() => {
        off()
        resolve()
      })
    })

    const initial = shikiPlugin.highlight(options as never) as {
      tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>>
    }
    expect(
      initial.tokens
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe(code)
    expect(initial.tokens.flat().some((token) => token.htmlStyle)).toBe(false)

    warmHighlighter()
    await ready

    const highlighted = shikiPlugin.highlight(options as never) as {
      tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>>
    }
    expect(
      highlighted.tokens
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe(code)
    expect(highlighted.tokens.flat().some((token) => token.htmlStyle)).toBe(true)
  })
})
