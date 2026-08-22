import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HighlighterRequest, HighlighterResponse } from './highlighter-protocol.js'
import { DARK_THEME, LIGHT_THEME } from './highlighter-config.js'
import { shikiPlugin } from './highlighter.js'

class SyntaxWorker {
  onmessage: ((event: MessageEvent<HighlighterResponse>) => void) | null = null
  onerror: (() => void) | null = null

  postMessage(request: HighlighterRequest): void {
    queueMicrotask(() => {
      const response: HighlighterResponse =
        request.type === 'warm'
          ? { type: 'warmed', id: request.id }
          : {
              type: 'highlighted',
              id: request.id,
              result: {
                tokens: [[{ content: request.code, htmlStyle: { color: '#cf222e' } }]],
              },
            }
      this.onmessage?.({ data: response } as MessageEvent<HighlighterResponse>)
    })
  }

  terminate(): void {}
}

beforeAll(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', SyntaxWorker)
})

afterAll(async () => {
  await vi.runAllTimersAsync()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('syntax highlighter loading', () => {
  it('keeps code plain while its worker loads, then updates every waiting block', async () => {
    const code = 'const answer: number = 42'
    const options = {
      code,
      language: 'typescript',
      themes: [LIGHT_THEME, DARK_THEME],
    } as const
    let resolveHighlighted:
      | ((result: {
          tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>>
        }) => void)
      | undefined
    const highlighted = new Promise<{
      tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>>
    }>((resolve) => {
      resolveHighlighted = resolve
    })
    let resolveDuplicate:
      | ((result: {
          tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>>
        }) => void)
      | undefined
    const duplicate = new Promise<{
      tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>>
    }>((resolve) => {
      resolveDuplicate = resolve
    })
    const initial = shikiPlugin.highlight(options as never, resolveHighlighted as never) as {
      tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>>
    }
    const duplicateInitial = shikiPlugin.highlight(options as never, resolveDuplicate as never)
    expect(
      initial.tokens
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe(code)
    expect(initial.tokens.flat().some((token) => token.htmlStyle)).toBe(false)
    expect(duplicateInitial?.tokens.flat().some((token) => token.htmlStyle)).toBe(false)

    const [result, duplicateResult] = await Promise.all([highlighted, duplicate])
    expect(
      result.tokens
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe(code)
    expect(result.tokens.flat().some((token) => token.htmlStyle)).toBe(true)
    expect(duplicateResult).toEqual(result)
  })
})
