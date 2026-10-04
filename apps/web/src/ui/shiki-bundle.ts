import {
  createBundledHighlighter,
  createSingletonShorthands,
  guessEmbeddedLanguages,
  type RegexEngine,
} from 'shiki/core'
import {
  createJavaScriptRegexEngine as createShikiJavaScriptRegexEngine,
  type JavaScriptRegexEngineOptions,
} from 'shiki/engine/javascript'
import { oneByteString } from './one-byte-string.js'
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

/**
 * Shiki's JavaScript engine, scanning one-byte copies of Latin-1 lines. Shiki
 * passes every line through `createString`, so this covers the chat worker and
 * the diff views alike. Lines cut from a reply or patch that contains any wider
 * character tokenized about twice as slowly in Electron 43 without the copy.
 */
export function createJavaScriptRegexEngine(options?: JavaScriptRegexEngineOptions): RegexEngine {
  const engine = createShikiJavaScriptRegexEngine(options)
  return {
    createScanner: (patterns) => engine.createScanner(patterns),
    createString: (text) => engine.createString(oneByteString(text)),
  }
}

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
