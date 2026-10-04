import { bundledLanguagesInfo } from 'shiki/langs'
import { describe, expect, it } from 'vitest'
import { createHighlighterWorkerRuntime } from './highlighter-worker-runtime.js'
import { bundledLanguages, languageAliases, plainLanguages } from './shiki-languages.js'

const shikiCatalog = new Map<string, string>()
for (const language of bundledLanguagesInfo) {
  shikiCatalog.set(language.id, language.id)
  for (const alias of language.aliases ?? []) shikiCatalog.set(alias, language.id)
}

describe('curated Shiki catalog', () => {
  it('answers for every id and alias the installed Shiki knows', () => {
    const missing = [...shikiCatalog.keys()].filter(
      (name) => !Object.hasOwn(bundledLanguages, name),
    )
    expect(missing).toEqual([])
  })

  it('carries no names Shiki dropped', () => {
    const stale = Object.keys(bundledLanguages).filter((name) => !shikiCatalog.has(name))
    expect(stale).toEqual([])
  })

  it('maps aliases to the same grammar Shiki does', () => {
    const wrong = Object.entries(languageAliases).filter(
      ([alias, target]) => shikiCatalog.get(alias) !== target,
    )
    expect(wrong).toEqual([])
  })

  it('keeps shipped grammars and plain stand-ins disjoint', () => {
    const shipped = new Set(Object.values(languageAliases))
    const overlap = plainLanguages.filter(
      (name) => shipped.has(name as never) || Object.hasOwn(languageAliases, name),
    )
    expect(overlap).toEqual([])
    expect(new Set(plainLanguages).size).toBe(plainLanguages.length)
  })

  it('renders an unshipped language as plain text instead of failing', async () => {
    const runtime = await createHighlighterWorkerRuntime()
    const code = '(defun answer () 42)\n(answer)'
    const result = await runtime.highlight(code, 'emacs-lisp')

    expect(result?.tokens.map((line) => line.map((token) => token.content).join(''))).toEqual(
      code.split('\n'),
    )
    expect(result?.tokens.every((line) => line.length === 1)).toBe(true)
  })
})
