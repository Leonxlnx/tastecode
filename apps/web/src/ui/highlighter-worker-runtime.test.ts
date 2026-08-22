import { describe, expect, it } from 'vitest'
import { createHighlighterWorkerRuntime } from './highlighter-worker-runtime.js'

describe('highlighter worker parser', () => {
  it('loads a grammar on demand and returns structured-clone-safe tokens', async () => {
    const runtime = await createHighlighterWorkerRuntime()
    const code = 'const answer: number = 42'
    const result = await runtime.highlight(code, 'typescript')

    expect(
      result?.tokens
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe(code)
    expect(result?.tokens.flat().some((token) => token.htmlStyle)).toBe(true)
    expect(structuredClone(result)).toEqual(result)
  })

  it('rejects unknown grammars without parsing the code', async () => {
    const runtime = await createHighlighterWorkerRuntime()
    await expect(runtime.highlight('plain', 'not-a-real-language')).resolves.toBeUndefined()
  })
})
