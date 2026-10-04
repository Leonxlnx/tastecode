import { bench, describe } from 'vitest'
import { LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT, LiveMarkdownParser } from './live-markdown.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const PARSER_OPTIONS = { time: 1_200, warmupTime: 300 }
const PLAIN_TEXT = 'x'.repeat(100_000)
const LARGE_PLAIN_TEXT = 'x'.repeat(1024 * 1024)
const COALESCED_DELTA = 'plain streamed response text chunk '
const COALESCED_DELTA_COUNT = 10_000
const SOURCE_CHUNK_COUNT = 250_000

function legacySource(): string {
  let prefix = ''
  let chunks: string[] = []
  for (let index = 0; index < SOURCE_CHUNK_COUNT; index += 1) {
    chunks.push('x')
    if (chunks.length >= LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT) {
      prefix += chunks.join('')
      chunks = []
    }
  }
  return prefix + chunks.join('')
}

function segmentedSource(): string {
  const segments: string[] = []
  let chunks: string[] = []
  for (let index = 0; index < SOURCE_CHUNK_COUNT; index += 1) {
    chunks.push('x')
    if (chunks.length >= LIVE_MARKDOWN_SOURCE_CHUNK_LIMIT) {
      segments.push(chunks.join(''))
      chunks = []
    }
  }
  if (chunks.length > 0) segments.push(chunks.join(''))
  return segments.join('')
}

function assertCompleteSource(source: string): void {
  if (source.length !== SOURCE_CHUNK_COUNT || source.indexOf('y') !== -1) {
    throw new Error('source was truncated')
  }
}

describe('live Markdown parser', () => {
  bench(
    'accumulates 100,000 one-character deltas',
    () => {
      const parser = new LiveMarkdownParser()
      for (let index = 0; index < PLAIN_TEXT.length; index += 1) parser.append('x')
      if (parser.complete().source.length !== PLAIN_TEXT.length) {
        throw new Error('source was truncated')
      }
    },
    PARSER_OPTIONS,
  )

  bench(
    'parses 10,000 coalesced plain-text deltas',
    () => {
      const parser = new LiveMarkdownParser()
      for (let index = 0; index < COALESCED_DELTA_COUNT; index += 1) {
        parser.append(COALESCED_DELTA)
      }
      if (parser.complete().source.length !== COALESCED_DELTA.length * COALESCED_DELTA_COUNT) {
        throw new Error('source was truncated')
      }
    },
    PARSER_OPTIONS,
  )

  bench(
    'parses a 100,000-character plain-text burst',
    () => {
      const parser = new LiveMarkdownParser()
      const update = parser.appendLarge(PLAIN_TEXT)
      if (update.sourceLength !== PLAIN_TEXT.length) throw new Error('source was truncated')
    },
    PARSER_OPTIONS,
  )

  bench(
    'parses a 1 MiB plain-text burst',
    () => {
      const parser = new LiveMarkdownParser()
      const update = parser.appendLarge(LARGE_PLAIN_TEXT)
      if (update.sourceLength !== LARGE_PLAIN_TEXT.length) throw new Error('source was truncated')
    },
    PARSER_OPTIONS,
  )
})

describe('live Markdown source storage', () => {
  bench('extends a cumulative prefix', () => assertCompleteSource(legacySource()), OPTIONS)
  bench('joins compact segments once', () => assertCompleteSource(segmentedSource()), OPTIONS)
})
