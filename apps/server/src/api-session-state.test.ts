import type { ApiAgentSession } from '@harness/adapter-api'
import { describe, expect, it } from 'vitest'
import { persistentApiSession } from './api-session-state.js'

const createdAt = 1_700_001_234_567

function fakeSession(content: string): ApiAgentSession {
  return {
    snapshot: () => ({
      thread: {
        id: 'thread-1',
        provider: 'api',
        connectionId: 'local',
        workspacePath: '/workspace',
        createdAt,
      },
      messages: [
        { role: 'user', content },
        { role: 'assistant', content: 'done', toolCalls: [] },
      ],
      turnCounter: 1,
    }),
  } as unknown as ApiAgentSession
}

function sessionWith(messages: unknown[]): ApiAgentSession {
  return {
    snapshot: () => ({
      thread: {
        id: 'thread-1',
        provider: 'api',
        connectionId: 'local',
        workspacePath: '/workspace',
        createdAt,
      },
      messages: structuredClone(messages),
      turnCounter: 1,
    }),
  } as unknown as ApiAgentSession
}

function snapshot(apiKey: string, content = 'hello', model = 'gpt-4o') {
  return persistentApiSession(fakeSession(content), model, apiKey).snapshot!() as {
    model: string
    state: { thread: { createdAt: number }; messages: Array<{ role: string; content: string }> }
  }
}

describe('persistentApiSession', () => {
  it('removes the key from every saved message', () => {
    const key = 'sk-test-0123456789abcdef'
    const saved = snapshot(key, `my key is ${key} and "${key}"`)
    expect(JSON.stringify(saved)).not.toContain(key)
    expect(saved.state.messages[0]?.content).toBe('my key is [redacted] and "[redacted]"')
  })

  it('keeps the saved state valid when a placeholder key matches its structure', () => {
    // Local OpenAI-compatible servers are often given keys like these.
    for (const key of ['1', '1234', 'a', 'version', 'assistant']) {
      const saved = snapshot(key)
      expect(saved.state.thread.createdAt).toBe(createdAt)
      expect(saved.state.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    }
  })

  it('removes the key from tool input object keys', () => {
    const key = 'sk-test-0123456789abcdef'
    const saved = persistentApiSession(
      sessionWith([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'shell', input: { [key]: { nested: [key] } } }],
        },
      ]),
      'gpt-4o',
      key,
    ).snapshot!()
    expect(JSON.stringify(saved)).not.toContain(key)
  })

  it('drops provider replay state that holds the key instead of corrupting its ids', () => {
    // A placeholder key such as "1" also occurs in provider ids. Rewriting the
    // id inside the replay state but not in the tool result would make the
    // provider reject the resumed conversation.
    const toolUse = { type: 'tool_use', id: 'toolu_01', name: 'shell', input: { command: 'ls' } }
    const clean = [{ type: 'text', text: 'ok' }]
    const saved = persistentApiSession(
      sessionWith([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_01', name: 'shell', input: { command: 'ls' } }],
          transportState: [toolUse],
        },
        { role: 'tool', content: 'files', toolCallId: 'toolu_01', isError: false },
        { role: 'assistant', content: 'ok', toolCalls: [], transportState: clean },
      ]),
      'gpt-4o',
      '1',
    ).snapshot!() as { state: { messages: Array<Record<string, unknown>> } }
    const [, withKey, result, withoutKey] = saved.state.messages
    expect(withKey).not.toHaveProperty('transportState')
    expect(withKey?.toolCalls).toEqual([
      { id: 'toolu_01', name: 'shell', input: { command: 'ls' } },
    ])
    expect(result?.toolCallId).toBe('toolu_01')
    expect(withoutKey?.transportState).toEqual(clean)
  })

  it('does not grow text that was already redacted when saved again', () => {
    // "[redacted]" itself contains short keys such as "e"; a resumed thread is
    // saved again after every turn.
    const once = snapshot('e', 'hello')
    const again = snapshot('e', once.state.messages[0]!.content)
    expect(again.state.messages[0]?.content).toBe(once.state.messages[0]?.content)
  })

  it('never rewrites the saved model', () => {
    const key = 'gpt-4o-placeholder'
    expect(snapshot(key, 'hi', 'gpt-4o-placeholder-mini').model).toBe('gpt-4o-placeholder-mini')
  })
})
