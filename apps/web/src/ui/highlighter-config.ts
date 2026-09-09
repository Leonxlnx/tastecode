import type { CodeHighlighterPlugin } from 'streamdown'

export const LIGHT_THEME = 'github-light-default'
export const DARK_THEME = 'github-dark-default'
export const MAX_HIGHLIGHT_CHARACTERS = 64 * 1024
export const HIGHLIGHT_QUEUE_CHARACTER_LIMIT = 256 * 1024
export const HIGHLIGHT_QUEUE_ENTRY_LIMIT = 32

/** Languages an agent emits constantly. Everything else loads on demand. */
export const COMMON_LANGUAGES = [
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
] satisfies ReturnType<CodeHighlighterPlugin['getSupportedLanguages']>

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>

/** One token per line, no colours — the shape Streamdown expects. */
export function plainHighlight(code: string): HighlightResult {
  return {
    tokens: code.split('\n').map((line) => [{ content: line }]),
  }
}
