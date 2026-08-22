import { afterAll, beforeAll, bench, describe, vi } from 'vitest'
import { createHighlighterRuntime, type HighlighterRuntime } from './highlighter-runtime.js'

const OPTIONS = { iterations: 3, time: 0, warmupIterations: 1, warmupTime: 0 }
const SHORT_TYPESCRIPT = Array.from(
  { length: 120 },
  (_, index) => `export const value${index}: number = ${index}`,
).join('\n')
const LONG_TYPESCRIPT = Array.from(
  { length: 1_000 },
  (_, index) => `export function value${index}(input: number): number { return input + ${index} }`,
).join('\n')

let runtime: HighlighterRuntime
let run = 0

class BenchmarkWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: (() => void) | null = null

  postMessage(): void {}
  terminate(): void {}
}

beforeAll(async () => {
  vi.stubGlobal('Worker', BenchmarkWorker)
  runtime = await createHighlighterRuntime([])
})

afterAll(() => {
  runtime.dispose()
  vi.unstubAllGlobals()
})

function highlight(code: string): void {
  const result = runtime.highlight(
    {
      code: `${code}\n// benchmark ${run++}`,
      language: 'typescript',
      themes: ['github-light-default', 'github-dark-default'],
    } as never,
    () => {},
  )
  if (!result || result.tokens.length === 0) throw new Error('missing highlighted tokens')
}

describe('completed code block highlighting on the renderer thread', () => {
  bench('highlights 120 TypeScript lines', () => highlight(SHORT_TYPESCRIPT), OPTIONS)
  bench('highlights 1,000 TypeScript lines', () => highlight(LONG_TYPESCRIPT), OPTIONS)
})
