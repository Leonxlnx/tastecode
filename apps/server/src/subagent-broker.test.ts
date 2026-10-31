import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item, Subagent } from '@harness/contracts'
import { AgentToolError } from './agent-tools-mcp.js'
import {
  SubagentBroker,
  shorten,
  type SubagentChildSpec,
  type SubagentHost,
  type SubagentOutcome,
  type SubagentParent,
} from './subagent-broker.js'
import { SUBAGENT_LIMITS } from './subagent-limits.js'
import { Store } from './store.js'

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

type FixtureState = {
  parent: SubagentParent
  outcome: SubagentOutcome
  createError?: Error
}

function fixture() {
  const store = new Store(':memory:')
  const recorded: Array<{ parentThreadId: string; event: DomainEvent }> = []
  const created: SubagentChildSpec[] = []
  const sent: Array<{ threadId: string; task: string }> = []
  const stopped: string[] = []
  const state: FixtureState = {
    parent: { provider: 'claude-code', turnId: 'turn-1', approval: 'auto' },
    outcome: { answer: 'All done.', changedPaths: ['src/a.ts'] },
  }
  let clock = 1_000
  const host: SubagentHost = {
    parent: () => state.parent,
    choices: () => [
      { provider: 'codex', models: [{ id: 'gpt-5.5', name: 'GPT-5.5', default: true }] },
    ],
    createChild: async (spec) => {
      created.push(spec)
      if (state.createError) throw state.createError
      return `child-${created.length}`
    },
    sendToChild: async (threadId, task) => {
      sent.push({ threadId, task })
    },
    stopChild: async (threadId) => {
      stopped.push(threadId)
    },
    outcome: () => state.outcome,
    recordOnParent: (parentThreadId, event) => recorded.push({ parentThreadId, event }),
  }
  const broker = new SubagentBroker(store.subagents, host, { now: () => clock })
  const rows = () =>
    recorded.map(({ event }) => (event as Extract<DomainEvent, { type: 'item.completed' }>).item)
  const lastRow = (): Item & { subagent: Subagent } =>
    rows().at(-1) as Item & { subagent: Subagent }
  return {
    store,
    broker,
    recorded,
    created,
    sent,
    stopped,
    state,
    rows,
    lastRow,
    tick: (ms: number) => (clock += ms),
  }
}

const caller = { threadId: 'parent' }
const start = (broker: SubagentBroker, task = 'Check the tests.') =>
  broker.start(caller, { provider: 'codex', model: 'gpt-5.5', task }) as Promise<{
    agent_id: string
    status: string
  }>
const toolCompleted = (id: string): DomainEvent => ({
  type: 'item.completed',
  item: { id, turnId: 'child-turn', type: 'command', status: 'completed', text: 'pnpm test' },
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SubagentBroker', () => {
  it('starts a child at once and hands its final answer back to a wait', async () => {
    const f = fixture()
    const started = await start(f.broker)
    expect(started).toEqual({
      agent_id: 'a1',
      status: 'running',
      provider: 'codex',
      model: 'gpt-5.5',
    })
    // The parent's row exists before the child chat does.
    expect(f.lastRow()).toMatchObject({
      type: 'tool_call',
      turnId: 'turn-1',
      subagent: { id: 'a1', state: 'running', provider: 'codex', model: 'gpt-5.5' },
    })
    await settle()
    expect(f.created).toEqual([
      {
        parentThreadId: 'parent',
        provider: 'codex',
        model: 'gpt-5.5',
        effort: undefined,
        name: undefined,
        task: 'Check the tests.',
      },
    ])
    expect(f.sent).toEqual([{ threadId: 'child-1', task: 'Check the tests.' }])
    expect(f.broker.isChild('child-1')).toBe(true)
    expect(f.lastRow().subagent.threadId).toBe('child-1')

    const waiting = f.broker.wait(
      caller,
      { return_when: 'all', timeout_seconds: 30 },
      new AbortController().signal,
    )
    f.tick(5_000)
    f.broker.childEvent('child-1', toolCompleted('c1'))
    f.broker.childEvent('child-1', {
      type: 'turn.completed',
      turnId: 'child-turn',
      status: 'completed',
    })
    await expect(waiting).resolves.toEqual({
      agents: [
        {
          agent_id: 'a1',
          status: 'completed',
          provider: 'codex',
          model: 'gpt-5.5',
          result: 'All done.',
          changed_paths: ['src/a.ts'],
          duration_seconds: 5,
        },
      ],
    })
    expect(f.lastRow().subagent).toMatchObject({
      state: 'completed',
      toolUses: 1,
      summary: 'All done.',
      durationMs: 5_000,
      threadId: 'child-1',
    })
    expect(f.store.subagents.ofParent('parent')[0]).toMatchObject({
      state: 'completed',
      result: 'All done.',
      threadId: 'child-1',
    })
    // A read result is not offered again by a wait without ids.
    await expect(
      f.broker.wait(
        caller,
        { return_when: 'all', timeout_seconds: 1 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ agents: [], note: 'This chat has not started any sub-agents.' })
  })

  it('refuses unknown providers and models, and chats that ask before acting', async () => {
    const f = fixture()
    await expect(f.broker.start(caller, { provider: 'cursor', task: 'x' })).rejects.toBeInstanceOf(
      AgentToolError,
    )
    await expect(
      f.broker.start(caller, { provider: 'codex', model: 'nope', task: 'x' }),
    ).rejects.toThrow('"nope" is not a model of codex')
    f.state.parent = { ...f.state.parent, approval: 'ask' }
    await expect(start(f.broker)).rejects.toThrow('asks the user before it acts')
    expect(f.recorded).toEqual([])
    expect(f.store.subagents.ofParent('parent')).toEqual([])
  })

  it('holds the running and per-turn limits', async () => {
    const f = fixture()
    for (let index = 0; index < SUBAGENT_LIMITS.runningPerChat; index += 1) await start(f.broker)
    await expect(start(f.broker)).rejects.toThrow(
      `At most ${SUBAGENT_LIMITS.runningPerChat} sub-agents of one chat run at once`,
    )
    // Another chat may run its own, up to the app-wide limit.
    const other = { threadId: 'other' }
    for (
      let index = 0;
      index < SUBAGENT_LIMITS.runningInApp - SUBAGENT_LIMITS.runningPerChat;
      index += 1
    ) {
      await f.broker.start(other, { provider: 'codex', task: 'x' })
    }
    await expect(
      f.broker.start({ threadId: 'third' }, { provider: 'codex', task: 'x' }),
    ).rejects.toThrow(`TasteCode runs at most ${SUBAGENT_LIMITS.runningInApp} sub-agents at once`)
  })

  it('updates the parent row at most once a second, and at once on a state change', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const before = f.rows().length
    f.broker.childEvent('child-1', {
      type: 'item.delta',
      itemId: 'm1',
      turnId: 'child-turn',
      delta: 'ignored',
    } as DomainEvent)
    f.broker.childEvent('child-1', toolCompleted('c1'))
    f.broker.childEvent('child-1', toolCompleted('c2'))
    f.broker.childEvent('child-1', toolCompleted('c3'))
    expect(f.rows().length).toBe(before)
    f.tick(1_000)
    vi.advanceTimersByTime(1_000)
    expect(f.rows().length).toBe(before + 1)
    expect(f.lastRow().subagent).toMatchObject({ toolUses: 3, lastTool: 'Shell' })
    f.broker.childEvent('child-1', {
      type: 'approval.requested',
      request: { id: 'ap1', turnId: 'child-turn', kind: 'command', title: 'Run' },
    } as DomainEvent)
    expect(f.rows().length).toBe(before + 2)
    expect(f.lastRow().subagent.attention).toBe('approval')
  })

  it('marks what still runs as background when the parent turn ends', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    f.broker.parentTurnEnded('parent')
    expect(f.lastRow().subagent.background).toBe(true)
  })

  it('stops a running child and reports why a start failed', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    await expect(f.broker.stop(caller, { agent_id: 'a1' })).resolves.toMatchObject({
      agent_id: 'a1',
      status: 'stopped',
    })
    expect(f.stopped).toEqual(['child-1'])
    expect(f.lastRow().subagent.state).toBe('interrupted')

    f.state.createError = new Error('Codex is not signed in.')
    await start(f.broker)
    await settle()
    const report = (await f.broker.wait(
      caller,
      { agent_ids: ['a2'], return_when: 'all', timeout_seconds: 1 },
      new AbortController().signal,
    )) as { agents: Array<Record<string, unknown>> }
    expect(report.agents[0]).toMatchObject({ status: 'failed', error: 'Codex is not signed in.' })
  })

  it('ends a wait on timeout or when the caller hangs up', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    const controller = new AbortController()
    const waiting = f.broker.wait(
      caller,
      { return_when: 'all', timeout_seconds: 50 },
      controller.signal,
    )
    controller.abort()
    await expect(waiting).resolves.toMatchObject({
      agents: [{ agent_id: 'a1', status: 'running' }],
      note: 'Some sub-agents are still running. Call wait_for_agents again.',
    })
    await expect(
      f.broker.wait(
        caller,
        { agent_ids: ['a9'], return_when: 'all', timeout_seconds: 1 },
        controller.signal,
      ),
    ).rejects.toThrow('Unknown agent_id: a9.')
  })

  it('keeps the start and the end of a long result', () => {
    const text = `${'a'.repeat(30_000)}${'z'.repeat(30_000)}`
    const short = shorten(text, SUBAGENT_LIMITS.resultCharacters)
    expect(short.length).toBe(SUBAGENT_LIMITS.resultCharacters)
    expect(short.startsWith('aaaa')).toBe(true)
    expect(short.endsWith('zzzz')).toBe(true)
    expect(short).toContain('[… shortened by TasteCode …]')
  })
})
