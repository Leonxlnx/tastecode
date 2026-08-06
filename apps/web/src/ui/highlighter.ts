import type { CodeHighlighterPlugin } from 'streamdown'
import { COMMON_LANGUAGES, DARK_THEME, LIGHT_THEME, plainHighlight } from './highlighter-config.js'
import type { HighlighterRuntime } from './highlighter-runtime.js'

/**
 * Lightweight facade for syntax highlighting.
 *
 * Markdown is part of the first render, but Shiki's grammar engine is not. The
 * heavy runtime loads behind this stable plugin after the app mounts; until it
 * is ready, code keeps the same line/token shape with plain text.
 */

let runtime: HighlighterRuntime | undefined
let booting: Promise<void> | undefined
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

export function onHighlighterChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Start loading common grammars after the first app render. */
export function warmHighlighter(): void {
  boot()
}

function boot(): void {
  booting ??= import('./highlighter-runtime.js')
    .then(({ createHighlighterRuntime }) => createHighlighterRuntime(announce))
    .then((created) => {
      runtime = created
      announce()
    })
    .catch((error: unknown) => {
      // Code stays plain rather than failing a message — but a silent catch
      // here cost an hour once, so it says why.
      console.warn('[highlighter] Shiki failed to load; code stays plain', error)
    })
}

export const shikiPlugin: CodeHighlighterPlugin = {
  type: 'code-highlighter',
  name: 'shiki',
  getSupportedLanguages: () => COMMON_LANGUAGES,
  getThemes: () => [LIGHT_THEME, DARK_THEME],
  supportsLanguage: () => true,

  highlight(options) {
    if (!runtime) {
      boot()
      return plainHighlight(options.code) as never
    }
    return runtime.highlight(options)
  },
}
