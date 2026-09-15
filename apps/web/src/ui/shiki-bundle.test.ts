import { disposeHighlighter, getFiletypeFromFileName, getSharedHighlighter } from '@pierre/diffs'
import { afterEach, describe, expect, it } from 'vitest'
import { createOnigurumaEngine } from 'shiki'

/**
 * `@pierre/diffs` imports the `shiki` entry, which the Vite config aliases to
 * `shiki-bundle.ts`. This drives its highlighter through that alias the way the
 * diff views do, so the curated catalog is proven against the third-party path
 * and not only against the app's own worker.
 */
describe('shiki alias for @pierre/diffs', () => {
  afterEach(() => disposeHighlighter())

  it('highlights a shipped grammar with real tokens', async () => {
    const highlighter = await getSharedHighlighter({
      themes: ['github-dark'],
      langs: ['typescript'],
      preferredHighlighter: 'shiki-js',
    })
    const { tokens } = highlighter.codeToTokens('const answer: number = 42', {
      lang: 'typescript',
      theme: 'github-dark',
    })

    expect(tokens[0]?.length).toBeGreaterThan(1)
    expect(highlighter.getLoadedLanguages()).toContain('typescript')
  })

  it.each([
    'github-dark',
    'github-light',
    'github-dark-default',
    'github-light-default',
    'pierre-dark',
    'pierre-light',
  ])('keeps the %s diff theme after trimming unused theme loaders', async (theme) => {
    const highlighter = await getSharedHighlighter({
      themes: [theme],
      langs: ['cpp', 'tsx', 'vue'],
      preferredHighlighter: 'shiki-js',
    })
    const code = 'const answer = 42;'
    for (const lang of ['cpp', 'tsx']) {
      const { tokens } = highlighter.codeToTokens(code, { lang, theme })
      expect(tokens[0]?.map((token) => token.content).join('')).toBe(code)
      expect(tokens[0]?.length).toBeGreaterThan(1)
    }
    expect(highlighter.getLoadedLanguages()).toContain('vue')
  })

  it('resolves an unshipped grammar to plain text instead of rejecting', async () => {
    const lang = getFiletypeFromFileName('init.el')
    expect(lang).toBe('emacs-lisp')

    const highlighter = await getSharedHighlighter({
      themes: ['github-dark'],
      langs: [lang],
      preferredHighlighter: 'shiki-js',
    })
    const code = '(defun answer () 42)\n(answer)'
    const { tokens } = highlighter.codeToTokens(code, { lang, theme: 'github-dark' })

    expect(tokens.map((line) => line.map((token) => token.content).join(''))).toEqual(
      code.split('\n'),
    )
    expect(tokens.every((line) => line.length === 1)).toBe(true)
  })

  it('refuses the Oniguruma engine the CSP could never run', () => {
    expect(() => createOnigurumaEngine()).toThrow(/WebAssembly/)
  })
})
