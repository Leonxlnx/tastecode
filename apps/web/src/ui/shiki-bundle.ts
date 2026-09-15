import {
  createBundledHighlighter,
  createSingletonShorthands,
  guessEmbeddedLanguages,
} from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from './shiki-languages.js'

/**
 * Stand-in for the `shiki` package entry.
 *
 * The real entry registers every grammar (~235 lazy chunks) and the Oniguruma
 * WASM engine, and `@pierre/diffs` imports it for the diff views. `vite.config.ts`
 * aliases `shiki` to this module so both the renderer and the highlighter worker
 * resolve the same curated catalog, and the JavaScript regex engine is the only
 * engine that exists: the renderer CSP blocks `wasm-unsafe-eval`, so Oniguruma
 * could never run here anyway.
 */
export * from 'shiki/core'
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
export {
  bundledLanguages,
  languageAliases,
  plainLanguages,
  type BundledLanguage,
  type ShippedLanguage,
} from './shiki-languages.js'

export const bundledThemes = {
  'github-dark-default': () => import('@shikijs/themes/github-dark-default'),
  'github-light-default': () => import('@shikijs/themes/github-light-default'),
}

export type BundledTheme = keyof typeof bundledThemes

export const createHighlighter = createBundledHighlighter<BundledLanguage, BundledTheme>({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
})

export const {
  codeToHtml,
  codeToHast,
  codeToTokens,
  codeToTokensBase,
  codeToTokensWithThemes,
  getSingletonHighlighter,
  getLastGrammarState,
} = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages })

export function createOnigurumaEngine(): never {
  throw new Error(
    'The Oniguruma WASM engine is not bundled; the renderer CSP forbids WebAssembly. Use createJavaScriptRegexEngine.',
  )
}
