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

  it('never rewrites the saved model', () => {
    const key = 'gpt-4o-placeholder'
    expect(snapshot(key, 'hi', 'gpt-4o-placeholder-mini').model).toBe('gpt-4o-placeholder-mini')
  })
})
