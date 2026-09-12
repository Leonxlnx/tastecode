import { bench, describe } from 'vitest'
import { createSearchSnippet } from './store.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const FILLER = Array.from({ length: 20_000 }, (_, index) => `token${index}`).join(' ')
const EARLY_MATCH = `Performance ${FILLER}`
const LATE_MATCH = `${FILLER} performance`

function assertSnippet(value: string): void {
  const snippet = createSearchSnippet(value, ['performance'])
  if (!snippet.some((part) => part.highlighted && part.text.toLowerCase() === 'performance')) {
    throw new Error('missing highlighted search term')
  }
}

describe('long global-search snippets', () => {
  bench(
    'formats an early match in a 20,001-token message',
    () => assertSnippet(EARLY_MATCH),
    OPTIONS,
  )
  bench('formats a late match in a 20,001-token message', () => assertSnippet(LATE_MATCH), OPTIONS)
})
