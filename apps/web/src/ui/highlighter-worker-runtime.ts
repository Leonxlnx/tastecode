import { bundledLanguages, createHighlighter, type BundledLanguage } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { DARK_THEME, LIGHT_THEME } from './highlighter-config.js'
import type { HighlightResult } from './highlighter-protocol.js'

export type HighlighterWorkerRuntime = {
  highlight: (code: string, language: string) => Promise<HighlightResult | undefined>
  warm: (languages: readonly string[]) => Promise<void>
}

/** The Shiki parser and grammars live only inside the disposable worker realm. */
export async function createHighlighterWorkerRuntime(): Promise<HighlighterWorkerRuntime> {
  const highlighter = await createHighlighter({
    themes: [LIGHT_THEME, DARK_THEME],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  const loaded = new Set<string>()
  const loading = new Map<string, Promise<boolean>>()

  const ensureLanguage = async (language: string): Promise<boolean> => {
    if (loaded.has(language)) return true
    const active = loading.get(language)
    if (active) return active
    if (!isBundledLanguage(language)) return false

    const request = highlighter
      .loadLanguage(bundledLanguages[language])
      .then(() => {
        loaded.add(language)
        return true
      })
      .catch(() => false)
      .finally(() => loading.delete(language))
    loading.set(language, request)
    return request
  }

  return {
    async highlight(code, language) {
      if (!(await ensureLanguage(language)) || !isBundledLanguage(language)) return undefined
      return highlighter.codeToTokens(code, {
        lang: language,
        themes: { light: LIGHT_THEME, dark: DARK_THEME },
      })
    },
    async warm(languages) {
      await Promise.all(languages.map((language) => ensureLanguage(language)))
    },
  }
}

function isBundledLanguage(language: string): language is BundledLanguage {
  return Object.hasOwn(bundledLanguages, language)
}
