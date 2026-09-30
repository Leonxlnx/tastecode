import { describe, expect, it } from 'vitest'
import { boundedContext, contextBudgetBytes } from './context-budget.js'
import { ApiAgentSession, type ApiMessage } from './runtime.js'

describe('API context budget', () => {
  it('selects conservative defaults for unknown models', () => {
    expect(contextBudgetBytes('custom-small-model')).toBe(8192)
    expect(contextBudgetBytes('gpt-4-0613')).toBe(8192)
    expect(contextBudgetBytes('gpt-4o')).toBe(65536)
    expect(contextBudgetBytes('gpt-5')).toBe(65536)
    expect(contextBudgetBytes('claude-sonnet-4-6')).toBe(65536)
  })

  it('drops whole historical turns, preserving tool pairs and current intent', () => {
    const messages: ApiMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old-call', name: 'test', input: {} }] },
      { role: 'tool', content: 'x'.repeat(10000), toolCallId: 'old-call', isError: false },
      { role: 'assistant', content: 'done', toolCalls: [] },
      { role: 'user', content: 'latest intent' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'current-call', name: 'test', input: {} }],
      },
      { role: 'tool', content: 'result', toolCallId: 'current-call', isError: false },
    ]
    const result = boundedContext(messages, [], 'test', 2048, 'Keep instructions')
    expect(result.removedTurns).toBe(1)
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0]?.content).toContain('Keep instructions')
    expect(result.messages[0]?.content).toContain('latest intent')
    expect(result.messages[2]?.content).toBe('result')
    expect(messages).toHaveLength(7)
  })

  it('rejects oversize current turns and tool definitions without truncating them', () => {
    expect(() =>
      boundedContext([{ role: 'user', content: 'é'.repeat(1100) }], [], 'test', 2048),
    ).toThrow('current turn exceeds')
    expect(() =>
      boundedContext(
        [{ role: 'user', content: 'go' }],
        [{ name: 'tool', description: 'x'.repeat(3000), inputSchema: {} }],
        'test',
        2048,
      ),
    ).toThrow('current turn exceeds')
  })

  it('keeps 300 real session requests bounded and publishes visible omission notices', async () => {
    const sizes: number[] = []
    const notices: string[] = []
    const session = new ApiAgentSession({
      model: 'test',
      contextBudgetBytes: 2048,
      instructions: 'Keep instructions',
      transport: async function* ({ messages, tools, model }) {
        sizes.push(Buffer.byteLength(JSON.stringify({ model, messages, tools })))
        expect(messages[0]?.content).toContain('Keep instructions')
        yield { type: 'text', delta: 'answer'.repeat(30) }
        yield { type: 'finish', reason: 'stop' }
      },
    })
    session.on('event', (event) => {
      if (event.type === 'item.completed' && event.item.type === 'message')
        notices.push(event.item.text)
    })
    const thread = session.startThread('/fixture', 'fixture')
    for (let i = 0; i < 300; i++)
      await session.waitForTurn(await session.sendTurn(thread.id, `Question ${i}`))
    expect(sizes).toHaveLength(300)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2048)
    expect(notices.some((text) => text.startsWith('Context limit:'))).toBe(true)
    expect(session.snapshot().messages.length).toBeLessThan(30)
  })
})
