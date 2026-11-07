import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item, Subagent } from '@harness/contracts'
import { AgentToolError } from './agent-tools-mcp.js'
import {
  SubagentBroker,
  mentions,
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
  otherProviders: boolean
  /** Holds createChild until it resolves, like a chat that takes a while to start. */
  createGate?: Promise<void>
}

function fixture() {
  const store = new Store(':memory:')
  const recorded: Array<{ parentThreadId: string; event: DomainEvent }> = []
  const created: SubagentChildSpec[] = []
  const sent: Array<{ threadId: string; task: string }> = []
  const stopped: string[] = []
  const released: string[] = []
  const interrupted: string[] = []
  const state: FixtureState = {
    parent: {
      provider: 'claude-code',
      providerName: 'Claude Code',
      turnId: 'turn-1',
      approval: 'auto',
    },
    outcome: { answer: 'All done.', changedPaths: ['src/a.ts'] },
    otherProviders: true,
  }
  let clock = 1_000
  const host: SubagentHost = {
    parent: () => state.parent,
    choices: () => [
      {
        provider: 'codex',
        name: 'Codex',
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5', default: true }],
      },
      {
        provider: 'claude-code',
        name: 'Claude Code',
        models: [{ id: 'opus', name: 'Opus 5.5', default: true }],
      },
    ],
    otherProvidersAllowed: () => state.otherProviders,
    createChild: async (spec) => {
      created.push(spec)
      const id = `child-${created.length}`
      await state.createGate
      if (state.createError) throw state.createError
      return id
    },
    sendToChild: async (threadId, task) => {
      sent.push({ threadId, task })
    },
    stopChild: async (threadId) => {
      stopped.push(threadId)
    },
    releaseChild: async (threadId) => {
      released.push(threadId)
    },
    outcome: () => state.outcome,
    recordOnParent: (parentThreadId, event) => recorded.push({ parentThreadId, event }),
    interruptParent: async (threadId) => {
      interrupted.push(threadId)
    },
  }
  const broker = new SubagentBroker(store.subagents, host, { now: () => clock })
  const rows = () =>
    recorded.flatMap(({ event }) => (event.type === 'item.completed' ? [event.item] : []))
  const approvals = () =>
    recorded.flatMap(({ event }) =>
      event.type === 'approval.requested' || event.type === 'approval.resolved' ? [event] : [],
    )
  const lastRow = (): Item & { subagent: Subagent } =>
    rows().at(-1) as Item & { subagent: Subagent }
  return {
    store,
    host,
    broker,
    recorded,
    created,
    sent,
    stopped,
    released,
    interrupted,
    state,
    rows,
    approvals,
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

  it('refuses unknown providers and models', async () => {
    const f = fixture()
    await expect(f.broker.start(caller, { provider: 'cursor', task: 'x' })).rejects.toBeInstanceOf(
      AgentToolError,
    )
    await expect(
      f.broker.start(caller, { provider: 'codex', model: 'nope', task: 'x' }),
    ).rejects.toThrow('"nope" is not a model of codex')
    expect(f.recorded).toEqual([])
    expect(f.store.subagents.ofParent('parent')).toEqual([])
  })

  it('asks once per start in a chat that asks before acting', async () => {
    const f = fixture()
    f.state.parent = { ...f.state.parent, approval: 'ask' }
    await expect(start(f.broker)).resolves.toMatchObject({
      agent_id: 'a1',
      status: 'waiting_for_approval',
    })
    await settle()
    expect(f.created).toEqual([])
    expect(f.lastRow().subagent).toMatchObject({ state: 'running', attention: 'approval' })
    const asked = f.approvals()[0] as Extract<DomainEvent, { type: 'approval.requested' }>
    expect(asked.request).toMatchObject({
      kind: 'permissions',
      reason: 'Start a subagent on codex (gpt-5.5): Check the tests.',
    })
    // A wait does not return at once for a start the user has not answered.
    const waiting = f.broker.wait(
      caller,
      { return_when: 'any', timeout_seconds: 30 },
      new AbortController().signal,
    )
    expect(f.broker.answer('other-chat', asked.request.id, 'approve')).toBe(false)
    expect(f.broker.answer('parent', 'provider-approval', 'approve')).toBe(false)
    expect(f.broker.answer('parent', asked.request.id, 'approve')).toBe(true)
    expect(f.approvals()[1]).toEqual({ type: 'approval.resolved', id: asked.request.id })
    await settle()
    expect(f.sent).toEqual([{ threadId: 'child-1', task: 'Check the tests.' }])
    expect(f.lastRow().subagent.attention).toBeUndefined()
    f.broker.childEvent('child-1', { type: 'turn.completed', turnId: 't', status: 'completed' })
    await expect(waiting).resolves.toMatchObject({ agents: [{ status: 'completed' }] })

    // Each start asks again; a no ends it without a chat.
    await expect(start(f.broker)).resolves.toMatchObject({ status: 'waiting_for_approval' })
    const second = f.approvals().at(-1) as Extract<DomainEvent, { type: 'approval.requested' }>
    expect(f.broker.answer('parent', second.request.id, 'deny')).toBe(true)
    expect(f.lastRow().subagent).toMatchObject({
      state: 'interrupted',
      summary: 'The user declined to start it.',
    })
    // A late second answer is not passed on to the chat's agent.
    expect(f.broker.answer('parent', second.request.id, 'approve')).toBe(true)

    // "Stop the turn" declines and stops the parent's turn.
    await start(f.broker)
    const third = f.approvals().at(-1) as Extract<DomainEvent, { type: 'approval.requested' }>
    f.broker.answer('parent', third.request.id, 'abort')
    expect(f.interrupted).toEqual(['parent'])

    // "Always this session" covers the chat's later starts.
    await start(f.broker)
    const fourth = f.approvals().at(-1) as Extract<DomainEvent, { type: 'approval.requested' }>
    f.broker.answer('parent', fourth.request.id, 'approve-session')
    await expect(start(f.broker)).resolves.toMatchObject({ agent_id: 'a5', status: 'running' })
    await settle()
    expect(f.created).toHaveLength(3)
  })

  it('ends an unanswered start with the turn that asked', async () => {
    const f = fixture()
    f.state.parent = { ...f.state.parent, approval: 'ask' }
    await start(f.broker)
    const asked = f.approvals()[0] as Extract<DomainEvent, { type: 'approval.requested' }>
    f.broker.parentTurnEnded('parent')
    expect(f.approvals()[1]).toEqual({ type: 'approval.resolved', id: asked.request.id })
    expect(f.store.subagents.ofParent('parent')[0]).toMatchObject({ state: 'declined' })
    expect(f.lastRow().subagent).toMatchObject({
      state: 'interrupted',
      summary: 'The turn ended before the user answered.',
    })
    expect(f.created).toEqual([])
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

  it('ends the agent of a child stopped while its chat was starting', async () => {
    const f = fixture()
    let open = () => {}
    f.state.createGate = new Promise<void>((resolve) => (open = resolve))
    await start(f.broker)
    await f.broker.stop(caller, { agent_id: 'a1' })
    expect(f.released).toEqual([])

    open()
    await settle()
    // The chat exists but gets no task, and its process does not idle on.
    expect(f.sent).toEqual([])
    expect(f.released).toEqual(['child-1'])
    expect(f.lastRow().subagent.state).toBe('interrupted')
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

describe('sub-agents on other providers', () => {
  const blocked = () => {
    const f = fixture()
    f.state.otherProviders = false
    return f
  }

  it('refuses another provider the user neither allowed nor asked for', async () => {
    const f = blocked()
    f.state.parent = { ...f.state.parent, prompt: 'Check the tests and fix what fails.' }
    await expect(start(f.broker)).rejects.toThrow(
      'Sub-agents in this chat run on Claude Code. Codex is only allowed',
    )
    expect(f.created).toEqual([])
    expect(f.rows()).toEqual([])
  })

  it('refuses another provider before any prompt was recorded', async () => {
    const f = blocked()
    await expect(start(f.broker)).rejects.toBeInstanceOf(AgentToolError)
  })

  it.each([
    ['the provider', 'Let a codex sub-agent review the tests.'],
    ['the provider id', 'Use claude-code and codex for this.'],
    ['the model', 'Have gpt-5.5 check the tests.'],
    ['the model, in other case', 'Run GPT-5.5 on the review.'],
  ])('starts another provider when the prompt names %s', async (_case, prompt) => {
    const f = blocked()
    f.state.parent = { ...f.state.parent, prompt }
    await expect(start(f.broker)).resolves.toMatchObject({ status: 'running', provider: 'codex' })
    await settle()
    expect(f.created).toHaveLength(1)
  })

  it('does not take a model of another provider as asking for it', async () => {
    const f = blocked()
    f.state.parent = { ...f.state.parent, prompt: 'Use Opus 5.5 for a second opinion.' }
    await expect(start(f.broker)).rejects.toBeInstanceOf(AgentToolError)
  })

  it("always starts on the chat's own provider", async () => {
    const f = blocked()
    await expect(
      f.broker.start(caller, { provider: 'claude-code', task: 'Check the tests.' }),
    ).resolves.toMatchObject({ status: 'running', provider: 'claude-code' })
  })

  it('starts another provider without asking when the user allows it', async () => {
    const f = fixture()
    await expect(start(f.broker)).resolves.toMatchObject({ status: 'running', provider: 'codex' })
  })

  it('still asks first in an ask chat when the prompt names the provider', async () => {
    const f = blocked()
    f.state.parent = { ...f.state.parent, approval: 'ask', prompt: 'Ask Codex to review.' }
    await expect(start(f.broker)).resolves.toMatchObject({ status: 'waiting_for_approval' })
    expect(f.created).toEqual([])
  })

  it('tells the agent its own provider and the rule', async () => {
    const f = blocked()
    await expect(f.broker.listModels(caller)).resolves.toMatchObject({
      own_provider: 'claude-code',
      other_providers: "only when the user's own message asks for that provider or model",
    })
    f.state.otherProviders = true
    await expect(f.broker.listModels(caller)).resolves.toMatchObject({
      other_providers: 'allowed when another provider or model fits the task better',
    })
  })
})

describe('mentions', () => {
  it('matches whole names, ignoring case', () => {
    expect(mentions('Use pi for this.', 'Pi')).toBe(true)
    expect(mentions('Fix the pipeline.', 'Pi')).toBe(false)
    expect(mentions('try OPENCODE', 'OpenCode')).toBe(true)
    expect(mentions('Run GPT-5.5 here', 'GPT-5.5')).toBe(true)
    expect(mentions('Run GPT-5x5 here', 'GPT-5.5')).toBe(false)
    expect(mentions('Run GPT-5.55 here', 'GPT-5.5')).toBe(false)
    expect(mentions('anything', '  ')).toBe(false)
  })
})

describe('a sub-agent the user prompts from its own chat', () => {
  const completeChild = (f: ReturnType<typeof fixture>, turnId = 'child-turn') =>
    f.broker.childEvent('child-1', { type: 'turn.completed', turnId, status: 'completed' })
  const startChildTurn = (f: ReturnType<typeof fixture>, id = 'child-turn-2') =>
    f.broker.childEvent('child-1', {
      type: 'turn.started',
      turn: { id, threadId: 'child-1', status: 'running', createdAt: 0 },
    })
  const waitOnce = (f: ReturnType<typeof fixture>) =>
    f.broker.wait(caller, { return_when: 'all', timeout_seconds: 1 }, new AbortController().signal)

  it('runs again and reports its new result to the parent once', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    completeChild(f)
    await expect(waitOnce(f)).resolves.toMatchObject({
      agents: [{ status: 'completed', result: 'All done.' }],
    })

    f.broker.userPrompted('child-1')
    startChildTurn(f)
    expect(f.lastRow().subagent).toMatchObject({ state: 'running', background: true })
    expect(f.lastRow().subagent.summary).toBeUndefined()
    expect(f.store.subagents.ofParent('parent')[0]).toMatchObject({ state: 'running' })
    expect(f.store.subagents.ofParent('parent')[0]!.result).toBeUndefined()

    f.state.outcome = { answer: 'Fixed the second test too.', changedPaths: ['src/b.ts'] }
    completeChild(f, 'child-turn-2')
    expect(f.lastRow().subagent).toMatchObject({
      state: 'completed',
      summary: 'Fixed the second test too.',
    })
    // The new result is news to the parent once, and only once.
    await expect(waitOnce(f)).resolves.toMatchObject({
      agents: [{ status: 'completed', result: 'Fixed the second test too.' }],
    })
    await expect(waitOnce(f)).resolves.toEqual({
      agents: [],
      note: 'This chat has not started any sub-agents.',
    })
    expect(f.broker.unreadResults('parent')).toBeUndefined()
  })

  it('counts the time it worked, not the wait for the user’s follow-up, also after a restart', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    f.tick(4_000)
    completeChild(f)
    expect(f.lastRow().subagent.durationMs).toBe(4_000)

    // The user follows up a minute later; that turn works for three seconds.
    f.tick(60_000)
    f.broker.userPrompted('child-1')
    startChildTurn(f)
    f.tick(3_000)
    completeChild(f, 'child-turn-2')
    expect(f.lastRow().subagent.durationMs).toBe(7_000)
    await expect(waitOnce(f)).resolves.toMatchObject({ agents: [{ duration_seconds: 7 }] })

    // A follow-up after a restart starts from the time the row kept.
    let clock = 200_000
    const restarted = new SubagentBroker(f.store.subagents, f.host, { now: () => clock })
    restarted.userPrompted('child-1')
    startChildTurn({ ...f, broker: restarted })
    clock += 2_000
    restarted.childEvent('child-1', {
      type: 'turn.completed',
      turnId: 'child-turn-3',
      status: 'completed',
    })
    expect(f.lastRow().subagent.durationMs).toBe(9_000)
  })

  it('does not reopen for a turn the user did not send, such as one that starts late after a Stop', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    await f.broker.stop(caller, { agent_id: 'a1' })
    expect(f.lastRow().subagent.state).toBe('interrupted')
    startChildTurn(f)
    expect(f.lastRow().subagent.state).toBe('interrupted')
    expect(f.store.subagents.ofParent('parent')[0]).toMatchObject({ state: 'stopped' })
  })

  it('reopens a stopped run when the user prompts it', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    await f.broker.stop(caller, { agent_id: 'a1' })
    f.broker.userPrompted('child-1')
    startChildTurn(f)
    expect(f.lastRow().subagent.state).toBe('running')
  })

  it('reopens for a prompt that waited behind the turn still running', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    // Sent while the task ran: it queues, and its turn starts after the task's ends.
    f.broker.userPrompted('child-1')
    completeChild(f)
    expect(f.lastRow().subagent.state).toBe('completed')
    startChildTurn(f)
    expect(f.lastRow().subagent.state).toBe('running')
  })

  it('reopens a run from before a restart with its stored counts', async () => {
    const f = fixture()
    await start(f.broker)
    await settle()
    f.broker.childEvent('child-1', toolCompleted('c1'))
    completeChild(f)
    const restarted = new SubagentBroker(f.store.subagents, f.host, { now: () => 9_000 })
    restarted.userPrompted('child-1')
    restarted.childEvent('child-1', {
      type: 'turn.started',
      turn: { id: 'child-turn-2', threadId: 'child-1', status: 'running', createdAt: 0 },
    })
    expect(f.lastRow().subagent).toMatchObject({ state: 'running', toolUses: 1 })
  })

  it('ignores a prompt to a chat that is not a sub-agent', () => {
    const f = fixture()
    f.broker.userPrompted('some-chat')
    f.broker.childEvent('some-chat', {
      type: 'turn.started',
      turn: { id: 't', threadId: 'some-chat', status: 'running', createdAt: 0 },
    })
    expect(f.recorded).toEqual([])
  })
})
