import { bundledLanguages, createHighlighter, type BundledLanguage } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { CodeHighlighterPlugin, HighlightOptions } from 'streamdown'
import { COMMON_LANGUAGES, DARK_THEME, LIGHT_THEME, plainHighlight } from './highlighter-config.js'

export type HighlighterRuntime = {
  highlight: CodeHighlighterPlugin['highlight']
}

/**
 * Shiki uses the JavaScript regex engine because the desktop CSP deliberately
 * blocks `wasm-unsafe-eval`. This module is a dynamic chunk so its parser,
 * engine, themes, and common grammars do not delay the first app render.
 */
export async function createHighlighterRuntime(announce: () => void): Promise<HighlighterRuntime> {
  const highlighter = await createHighlighter({
    themes: [LIGHT_THEME, DARK_THEME],
    langs: COMMON_LANGUAGES,
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  const loaded = new Set<string>(COMMON_LANGUAGES)
  const loading = new Set<string>()
  const languageRegistration = (language: string) => {
    if (!isBundledLanguage(language)) return undefined
    return { id: language, load: bundledLanguages[language] }
  }

  const requestLanguage = (language: string): void => {
    if (loaded.has(language) || loading.has(language)) return
    const registration = languageRegistration(language)
    if (!registration) return
    loading.add(language)
    void highlighter
      .loadLanguage(registration.load)
      .then(() => {
        loaded.add(language)
        announce()
      })
      .catch(() => {
        /* Unknown language: it stays plain. */
      })
      .finally(() => loading.delete(language))
  }

  return {
    highlight(options: HighlightOptions) {
      const language = String(options.language ?? '').toLowerCase()
      const registration = languageRegistration(language)
      if (!registration) return plainHighlight(options.code)
      if (!loaded.has(language)) {
        requestLanguage(language)
        return plainHighlight(options.code)
      }

      return highlighter.codeToTokens(options.code, {
        lang: registration.id,
        themes: { light: LIGHT_THEME, dark: DARK_THEME },
      })
    },
  }
}

function isBundledLanguage(language: string): language is BundledLanguage {
  return Object.hasOwn(bundledLanguages, language)
}
