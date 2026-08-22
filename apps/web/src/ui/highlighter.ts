import type { CodeHighlighterPlugin, HighlightOptions } from 'streamdown'
import {
  COMMON_LANGUAGES,
  DARK_THEME,
  HIGHLIGHT_QUEUE_CHARACTER_LIMIT,
  HIGHLIGHT_QUEUE_ENTRY_LIMIT,
  LIGHT_THEME,
  MAX_HIGHLIGHT_CHARACTERS,
  plainHighlight,
} from './highlighter-config.js'
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
type HighlightCallback = NonNullable<Parameters<CodeHighlighterPlugin['highlight']>[1]>
type BootHighlight = {
  callbacks: Set<HighlightCallback>
  options: HighlightOptions
}
const bootHighlights = new Map<string, BootHighlight>()
let bootHighlightCharacters = 0

function queueBootHighlight(options: HighlightOptions, callback: HighlightCallback): void {
  const language = String(options.language ?? '').toLowerCase()
  if (options.code.length > MAX_HIGHLIGHT_CHARACTERS) return
  const key = `${language}\0${options.code}`
  const pending = bootHighlights.get(key)
  if (pending) {
    pending.callbacks.add(callback)
    return
  }
  if (
    bootHighlights.size >= HIGHLIGHT_QUEUE_ENTRY_LIMIT ||
    bootHighlightCharacters + options.code.length > HIGHLIGHT_QUEUE_CHARACTER_LIMIT
  ) {
    return
  }
  bootHighlights.set(key, { callbacks: new Set([callback]), options })
  bootHighlightCharacters += options.code.length
}

function flushBootHighlights(created: HighlighterRuntime): void {
  const pending = [...bootHighlights.values()]
  bootHighlights.clear()
  bootHighlightCharacters = 0
  for (const highlight of pending) {
    created.highlight(highlight.options, (result) => {
      for (const callback of highlight.callbacks) callback(result)
    })
  }
}

/** Explicitly preload common grammars when a caller knows they will be needed. */
export function warmHighlighter(): void {
  boot()
}

function boot(initialLanguage?: string): void {
  booting ??= import('./highlighter-runtime.js')
    .then(({ createHighlighterRuntime }) =>
      createHighlighterRuntime(initialLanguage ? [initialLanguage] : undefined),
    )
    .then((created) => {
      runtime = created
      flushBootHighlights(created)
    })
    .catch((error) => {
      bootHighlights.clear()
      bootHighlightCharacters = 0
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

  highlight(options, callback) {
    if (!runtime) {
      if (callback) queueBootHighlight(options, callback)
      boot(String(options.language ?? '').toLowerCase())
      return plainHighlight(options.code)
    }
    return runtime.highlight(options, callback)
  },
}

/** Streaming code stays cheap; the completed message swaps in Shiki once. */
export const plainCodePlugin: CodeHighlighterPlugin = {
  ...shikiPlugin,
  highlight: (options) => plainHighlight(options.code),
}
