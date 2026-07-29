import { createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { CodeHighlighterPlugin } from 'streamdown'

/**
 * Syntax highlighting, lazily and synchronously.
 *
 * Shiki runs a real TextMate grammar engine, so loading every language up front
 * costs megabytes and blocks the first paint. Nothing loads until a code block
 * appears; each grammar loads once on first sight.
 *
 * `highlight` never returns null and never uses the async callback. That path
 * looks natural and is a trap: during streaming the first call sees a partial
 * code fence, and the result it resolves with gets cached against the block —
 * so the finished code keeps rendering as its own first line forever. Instead
 * we return plain tokens immediately and re-render once when Shiki is ready.
 */

const THEME = 'github-dark-default'

/** Languages an agent emits constantly. Everything else loads on demand. */
const COMMON = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'bash',
  'shell',
  'python',
  'css',
  'html',
  'markdown',
  'yaml',
  'diff',
  'sql',
  'rust',
  'go',
] as BundledLanguage[]

let instance: Highlighter | undefined
let booting: Promise<void> | undefined
const loaded = new Set<string>()
const loading = new Set<string>()

const listeners = new Set<() => void>()

/** Re-render subscribers once new grammars are available. */
function announce(): void {
  for (const listener of listeners) listener()
}

export function onHighlighterChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Shiki's default engine is Oniguruma, compiled to WebAssembly — and our CSP
 * has no `wasm-unsafe-eval`, deliberately. Weakening the policy of the whole
 * app for a syntax highlighter is a bad trade, so we use the JavaScript regex
 * engine instead. It covers every grammar we ship and needs no WASM at all.
 */
/**
 * Start loading at app boot, not on first sight of a code block.
 *
 * Streamdown caches a block's highlight result, so whatever the first call
 * returns is what that block keeps. Warming up front means the first call
 * already has real tokens instead of the plain fallback winning forever.
 */
export function warmHighlighter(): void {
  boot()
}

function boot(): void {
  booting ??= createHighlighter({
    themes: [THEME],
    langs: COMMON,
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
    .then((created) => {
      instance = created
      for (const lang of COMMON) loaded.add(lang)
      announce()
    })
    .catch((error: unknown) => {
      // Code stays plain rather than failing a message — but a silent catch
      // here cost an hour once, so it says why.
      console.warn('[highlighter] Shiki failed to load; code stays plain', error)
    })
}

function requestLanguage(language: string): void {
  if (!instance || loaded.has(language) || loading.has(language)) return
  loading.add(language)
  void instance
    .loadLanguage(language as BundledLanguage)
    .then(() => {
      loaded.add(language)
      announce()
    })
    .catch(() => {
      /* Unknown language: it stays plain. */
    })
}

/** One token per line, no colours — the shape Streamdown expects. */
function plain(code: string) {
  return {
    tokens: code.split('\n').map((line) => [{ content: line }]),
  }
}

export const shikiPlugin: CodeHighlighterPlugin = {
  type: 'code-highlighter',
  name: 'shiki',
  getSupportedLanguages: () => COMMON,
  getThemes: () => [THEME, THEME],
  supportsLanguage: () => true,

  highlight(options) {
    const language = String(options.language ?? '').toLowerCase()

    if (!instance) {
      boot()
      return plain(options.code) as never
    }

    if (!loaded.has(language)) {
      requestLanguage(language)
      return plain(options.code) as never
    }

    return instance.codeToTokens(options.code, { lang: language, theme: THEME } as never) as never
  },
}
