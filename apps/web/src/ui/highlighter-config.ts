import type { CodeHighlighterPlugin } from 'streamdown'

export const LIGHT_THEME = 'github-light-default'
export const DARK_THEME = 'github-dark-default'

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
] as ReturnType<CodeHighlighterPlugin['getSupportedLanguages']>

/** One token per line, no colours — the shape Streamdown expects. */
export function plainHighlight(code: string) {
  return {
    tokens: code.split('\n').map((line) => [{ content: line }]),
  }
}
