import { readFileSync } from 'node:fs'
import type { DomainEvent } from '@harness/contracts'
import type { JsonRpcValue } from '@harness/proc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
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

type Frame = { method: string; params: JsonRpcValue }

/**
 * Captured from codex-cli 0.163.0 app-server: one turn on gpt-6-luna (multi-agent v2) that
 * spawns one subagent, waits for it and repeats its answer. Every notification after
 * turn/start, with account and moderation frames dropped and local paths replaced.
 */
const [meta, ...frames] = readFileSync(
  new URL('./fixtures/subagent-codex-0.163.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Frame & { meta?: { threadId: string; turnId: string } })
const PARENT = meta!.meta!.threadId
const PARENT_TURN = meta!.meta!.turnId
const CHILD = '01a14938-3aa8-7d40-b113-7f848c86d071'
const CHILD_TURN = '01a14938-b010-7911-ad78-8f2cd3b63b00'

const adapters: CodexAdapter[] = []

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
})

async function parentTurn() {
  const rpc = new FakeCodexRpc((method) => {
    if (method === 'thread/start') return { thread: { id: PARENT }, model: 'gpt-6-luna' }
    if (method === 'turn/start') return { turn: { id: PARENT_TURN } }
    return {}
  })
  proc.rpc = rpc
  const adapter = new CodexAdapter()
  adapters.push(adapter)
  const events: DomainEvent[] = []
  const logs: string[] = []
  adapter.on('event', (event) => events.push(event))
  adapter.on('log', (line) => logs.push(line))
  await adapter.start()
  const thread = await adapter.startThread('C:\\project')
  await adapter.sendTurn(thread.id, 'Use spawn_agent once')
  const failures: string[] = []
  // Like the stdio transport, a handler that throws costs only its own frame.
  const replay = (selected: Frame[] = frames) => {
    for (const frame of selected) {
      try {
        rpc.emitNotification(frame.method, frame.params)
      } catch {
        failures.push(frame.method)
      }
    }
  }
  return { adapter, rpc, events, logs, failures, replay }
}

function turnIds(events: DomainEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'turn.started') return [event.turn.id]
    if (event.type === 'turn.completed' || event.type === 'item.delta') return [event.turnId]
    if (event.type === 'item.started' || event.type === 'item.completed') return [event.item.turnId]
    return []
  })
}

describe('Codex subagent threads', () => {
  it('keeps the subagent thread out of the parent chat', async () => {
    const { events, replay } = await parentTurn()
    replay()

    expect(new Set(turnIds(events))).toEqual(new Set([PARENT_TURN]))
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: PARENT_TURN, status: 'completed' },
    ])
    // The subagent's command and answer stay in its own thread.
    const ids = events.flatMap((event) =>
      event.type === 'item.started' || event.type === 'item.completed' ? [event.item.id] : [],
    )
    expect(ids.some((id) => id.startsWith('exec-'))).toBe(false)
    expect(ids).not.toContain('msg_02e2d9a21fb80d93016ad341d87bb481918aeff9ea20c3cb4c')
  })

  it('reports only the parent thread usage', async () => {
    const { events, replay } = await parentTurn()
    replay()

    const totals = events.flatMap((event) =>
      event.type === 'usage.updated' && event.usage.cumulative ? [event.usage.totalTokens] : [],
    )
    // The subagent's own totals were 20,519 and 41,083 tokens.
    expect(totals).toEqual([20_672, 41_388, 62_187])
  })

  it('declines what a subagent asked when its turn ends unanswered', async () => {
    const { rpc, events } = await parentTurn()
    const answer = rpc.emitServerRequest('item/commandExecution/requestApproval', {
      threadId: CHILD,
      turnId: CHILD_TURN,
      itemId: 'exec-child',
      command: 'Get-Content notes.txt',
    })
    expect(events.some((event) => event.type === 'approval.requested')).toBe(true)

    rpc.emitNotification('turn/completed', {
      threadId: CHILD,
      turn: { id: CHILD_TURN, status: 'completed' },
    })

    await expect(answer).resolves.toEqual({ decision: 'decline' })
    expect(events.at(-1)).toMatchObject({ type: 'approval.resolved' })
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false)
  })

  it('does not announce the subagent thread as a chat thread', async () => {
    const { rpc, events } = await parentTurn()
    rpc.emitNotification('thread/started', {
      thread: { id: CHILD, parentThreadId: PARENT, cwd: 'C:\\project' },
    })
    expect(events.some((event) => event.type === 'thread.started')).toBe(false)
  })
})
