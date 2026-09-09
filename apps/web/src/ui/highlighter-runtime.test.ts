import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HighlighterRequest, HighlighterResponse } from './highlighter-protocol.js'
import {
  createHighlighterRuntime,
  MAX_HIGHLIGHT_CHARACTERS,
  type HighlighterRuntime,
} from './highlighter-runtime.js'

const OPTIONS = {
  code: 'const answer = 42',
  language: 'typescript',
  themes: ['github-light-default', 'github-dark-default'],
} as const
const RESULT = {
  tokens: [[{ content: OPTIONS.code, htmlStyle: { color: '#cf222e' } }]],
}

class ControlledWorker {
  static instances: ControlledWorker[] = []
  readonly messages: HighlighterRequest[] = []
  terminated = false
  onmessage: ((event: MessageEvent<HighlighterResponse>) => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    ControlledWorker.instances.push(this)
  }

  postMessage(request: HighlighterRequest): void {
    this.messages.push(request)
  }

  respond(response: HighlighterResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<HighlighterResponse>)
  }

  terminate(): void {
    this.terminated = true
  }
}

let runtime: HighlighterRuntime | undefined

beforeEach(() => {
  ControlledWorker.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('Worker', ControlledWorker)
})

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('renderer-side highlighter runtime', () => {
  it('coalesces duplicate work, caches the result, and releases the worker after idle', async () => {
    runtime = await createHighlighterRuntime([])
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()

    const first = runtime.highlight(OPTIONS as never, firstCallback)
    const second = runtime.highlight(OPTIONS as never, secondCallback)
    expect(
      first?.tokens
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe(OPTIONS.code)
    expect(
      second?.tokens
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe(OPTIONS.code)

    const worker = ControlledWorker.instances[0]!
    expect(worker.messages).toHaveLength(1)
    const request = worker.messages[0]!
    expect(request.type).toBe('highlight')
    worker.respond({ type: 'highlighted', id: request.id, result: RESULT })
    expect(firstCallback).toHaveBeenCalledWith(RESULT)
    expect(secondCallback).toHaveBeenCalledWith(RESULT)

    expect(runtime.highlight(OPTIONS as never)).toBe(RESULT)
    expect(worker.messages).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(worker.terminated).toBe(true)
  })

  it('keeps oversized code plain without starting the grammar worker', async () => {
    runtime = await createHighlighterRuntime([])
    const code = 'x'.repeat(MAX_HIGHLIGHT_CHARACTERS + 1)
    const callback = vi.fn()
    const result = runtime.highlight({ ...OPTIONS, code } as never, callback)

    expect(
      result?.tokens
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe(code)
    expect(callback).not.toHaveBeenCalled()
    expect(ControlledWorker.instances).toHaveLength(0)
  })

  it('sends only one grammar job to the worker at a time', async () => {
    runtime = await createHighlighterRuntime([])
    runtime.highlight(OPTIONS as never, () => {})
    runtime.highlight({ ...OPTIONS, code: 'const second = 2' } as never, () => {})

    const worker = ControlledWorker.instances[0]!
    expect(worker.messages).toHaveLength(1)
    const first = worker.messages[0]!
    worker.respond({ type: 'highlighted', id: first.id, result: RESULT })
    expect(worker.messages).toHaveLength(2)
  })

  it('evicts old highlighted results from its bounded cache', async () => {
    runtime = await createHighlighterRuntime([])
    const codes = [
      OPTIONS.code,
      ...Array.from({ length: 16 }, (_, index) => `const value${index} = ${index}`),
    ]
    for (const code of codes) {
      runtime.highlight({ ...OPTIONS, code } as never, () => {})
      const worker = ControlledWorker.instances[0]!
      const request = worker.messages.at(-1)!
      worker.respond({
        type: 'highlighted',
        id: request.id,
        result: { tokens: [[{ content: code }]] },
      })
    }

    const worker = ControlledWorker.instances[0]!
    runtime.highlight(OPTIONS as never, () => {})
    expect(worker.messages).toHaveLength(18)
  })
})
