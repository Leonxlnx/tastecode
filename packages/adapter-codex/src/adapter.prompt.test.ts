import { describe, expect, it, vi } from 'vitest'

type Call = { method: string; params: unknown; timeoutMs?: number }

const fake = vi.hoisted(() => ({
  calls: [] as Call[],
  spawnArgs: [] as string[],
}))

vi.mock('@harness/proc', () => ({
  spawnCli: vi.fn((_command: string, args: string[]) => {
    fake.spawnArgs = args
    return { pid: 1 }
  }),
  StdioJsonRpc: class {
    onStderr(): void {}
    onNotification(): void {}
    onServerRequest(): void {}
    notify(): void {}
    dispose(): void {}

    request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
      fake.calls.push({ method, params, timeoutMs: options?.timeoutMs })
      if (method === 'thread/start') {
        return Promise.resolve({ thread: { id: 'thread-1' }, model: 'gpt-5.6' })
      }
      if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn-1' } })
      return Promise.resolve({})
    }
  },
}))

const { CodexAdapter } = await import('./adapter.js')

describe('Codex prompt transport', () => {
  it('keeps long unicode and multiline prompts in structured JSON-RPC input', async () => {
    fake.calls = []
    const text = ` Grüße 🧪\n${'x'.repeat(40_000)}`
    const adapter = new CodexAdapter()
    await adapter.start()
    const thread = await adapter.startThread('C:\\repo')
    expect(fake.calls.find((call) => call.method === 'thread/start')?.timeoutMs).toBe(30_000)

    await adapter.sendTurn(thread.id, text)

    const turn = fake.calls.find((call) => call.method === 'turn/start')
    expect(turn?.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text, text_elements: [] }],
    })
    expect(fake.spawnArgs.join(' ')).not.toContain(text)
    adapter.dispose()
  })
})
