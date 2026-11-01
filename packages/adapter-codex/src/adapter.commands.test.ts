import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { codexCommandRequest } from './commands.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'

const proc = vi.hoisted(() => ({ rpc: undefined as FakeCodexRpc | undefined }))

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor() {
      if (!proc.rpc) throw new Error('fake Codex RPC was not installed')
      return proc.rpc
    }
  },
}))

const GOAL = {
  threadId: 'thread-1',
  objective: 'Ship the release',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
}

async function commandAdapter(
  onRequest: (method: string, rpc: FakeCodexRpc) => unknown = () => ({}),
) {
  const rpc: FakeCodexRpc = new FakeCodexRpc((method) => {
    if (method === 'thread/resume') {
      return { thread: { id: 'thread-1', createdAt: 1_700_000_000 }, model: 'gpt-5.6' }
    }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } }
    if (method === 'thread/goal/set') return { goal: GOAL }
    if (method === 'thread/goal/get') return { goal: null }
    if (method === 'review/start')
      return { turn: { id: 'review-turn' }, reviewThreadId: 'thread-1' }
    return onRequest(method, rpc) as never
  })
  proc.rpc = rpc
  const adapter = new CodexAdapter()
  const events: DomainEvent[] = []
  adapter.on('event', (event: DomainEvent) => events.push(event))
  await adapter.start()
  await adapter.resumeThread('thread-1', 'C:\\project', {})
  return { adapter, rpc, events }
}

describe('Codex slash commands', () => {
  it('builds each command from the generated protocol shapes', () => {
    expect(codexCommandRequest('t', '/goal Ship it ')).toEqual({
      method: 'thread/goal/set',
      params: { threadId: 't', objective: 'Ship it', status: 'active' },
    })
    expect(codexCommandRequest('t', '/goal')).toEqual({
      method: 'thread/goal/get',
      params: { threadId: 't' },
    })
    expect(codexCommandRequest('t', '/goal clear')?.method).toBe('thread/goal/clear')
    expect(codexCommandRequest('t', '/goal pause')).toEqual({
      method: 'thread/goal/set',
      params: { threadId: 't', status: 'paused' },
    })
    expect(codexCommandRequest('t', '/compact')).toEqual({
      method: 'thread/compact/start',
      params: { threadId: 't' },
    })
    expect(codexCommandRequest('t', '/review')).toEqual({
      method: 'review/start',
      params: { threadId: 't', target: { type: 'uncommittedChanges' }, delivery: 'inline' },
    })
    expect(codexCommandRequest('t', '/review only the parser')?.params).toMatchObject({
      target: { type: 'custom', instructions: 'only the parser' },
    })
  })

  it('leaves other text, unknown commands and compaction instructions as typed', () => {
    expect(codexCommandRequest('t', 'please /goal x')).toBeUndefined()
    expect(codexCommandRequest('t', '/deploy now')).toBeUndefined()
    expect(codexCommandRequest('t', '/compact keep the API notes')).toBeUndefined()
    expect(codexCommandRequest('t', '/goalkeeper')).toBeUndefined()
  })

  it('sets a goal instead of sending the text and shows the answer as its own turn', async () => {
    const { adapter, rpc, events } = await commandAdapter()
    try {
      const turnId = await adapter.sendTurn('thread-1', '/goal Ship the release')
      expect(rpc.calls.some((call) => call.method === 'turn/start')).toBe(false)
      expect(rpc.calls.find((call) => call.method === 'thread/goal/set')?.params).toEqual({
        threadId: 'thread-1',
        objective: 'Ship the release',
        status: 'active',
      })
      await vi.waitFor(() => expect(events).toHaveLength(3))
      expect(events[0]).toMatchObject({ type: 'turn.started', turn: { id: turnId } })
      expect(events[1]).toMatchObject({
        type: 'item.completed',
        item: { turnId, role: 'assistant', text: 'Goal set (active): Ship the release' },
      })
      expect(events[2]).toEqual({ type: 'turn.completed', turnId, status: 'completed' })
    } finally {
      await adapter.dispose()
    }
  })

  it('says so when the chat has no goal', async () => {
    const { adapter, events } = await commandAdapter()
    try {
      await adapter.sendTurn('thread-1', '/goal')
      await vi.waitFor(() => expect(events).toHaveLength(3))
      expect(events[1]).toMatchObject({
        item: { text: 'This chat has no goal. Set one with /goal <objective>.' },
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('returns the review turn the app-server started', async () => {
    const { adapter, rpc } = await commandAdapter()
    try {
      await expect(adapter.sendTurn('thread-1', '/review')).resolves.toBe('review-turn')
      expect(rpc.calls.some((call) => call.method === 'turn/start')).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it('returns the turn a compaction starts', async () => {
    const { adapter } = await commandAdapter((method, rpc) => {
      if (method === 'thread/compact/start') {
        queueMicrotask(() =>
          rpc.emitNotification('turn/started', {
            threadId: 'thread-1',
            turn: { id: 'compact-turn', items: [], status: 'inProgress', error: null },
          }),
        )
      }
      return {}
    })
    try {
      await expect(adapter.sendTurn('thread-1', '/compact')).resolves.toBe('compact-turn')
    } finally {
      await adapter.dispose()
    }
  })

  it('sends a command with attachments as typed text', async () => {
    const { adapter, rpc } = await commandAdapter()
    try {
      await expect(adapter.sendTurn('thread-1', '/review', ['C:\\a.txt'])).resolves.toBe('turn-1')
    } finally {
      await adapter.dispose()
    }
    expect(rpc.calls.some((call) => call.method === 'review/start')).toBe(false)
  })
})
