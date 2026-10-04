import { describe, expect, it } from 'vitest'
import { countWideGrammarScans, isOneByteString } from '../test-string-width.js'
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

  it('scans code blocks one byte wide when the reply contains a wider character', async () => {
    const runtime = await createHighlighterWorkerRuntime()
    await runtime.warm(['typescript'])
    const reply = 'Here is the fix — it retries once.\n\nconst answer: number = await load(42)'
    const code = reply.slice(reply.lastIndexOf('\n') + 1)
    expect(isOneByteString(code)).toBe(false)

    let result: Awaited<ReturnType<typeof runtime.highlight>>
    const counts = await countWideGrammarScans(async () => {
      result = await runtime.highlight(code, 'typescript')
    })

    expect(result?.tokens.flat().length).toBeGreaterThan(1)
    expect(counts.scans).toBeGreaterThan(0)
    expect(counts.wide).toBe(0)
  })

  it('rejects unknown grammars without parsing the code', async () => {
    const runtime = await createHighlighterWorkerRuntime()
    await expect(runtime.highlight('plain', 'not-a-real-language')).resolves.toBeUndefined()
  })
})
