import type { CodeHighlighterPlugin } from 'streamdown'

export type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>

export type HighlighterRequest =
  | { type: 'highlight'; id: number; code: string; language: string }
  | { type: 'warm'; id: number; languages: string[] }

export type HighlighterResponse =
  | { type: 'highlighted'; id: number; result: HighlightResult | null }
  | { type: 'warmed'; id: number }
  | { type: 'failed'; id: number }
