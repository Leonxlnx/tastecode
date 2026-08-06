import { createHighlighter, type BundledLanguage } from 'shiki'
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
    langs: COMMON_LANGUAGES as BundledLanguage[],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  const loaded = new Set<string>(COMMON_LANGUAGES)
  const loading = new Set<string>()

  const requestLanguage = (language: string): void => {
    if (loaded.has(language) || loading.has(language)) return
    loading.add(language)
    void highlighter
      .loadLanguage(language as BundledLanguage)
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
      if (!loaded.has(language)) {
        requestLanguage(language)
        return plainHighlight(options.code) as never
      }

      return highlighter.codeToTokens(options.code, {
        lang: language,
        themes: { light: LIGHT_THEME, dark: DARK_THEME },
      } as never) as never
    },
  }
}
