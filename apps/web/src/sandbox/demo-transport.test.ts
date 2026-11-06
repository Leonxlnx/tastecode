import type { DataOf, DomainEvent } from '@harness/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DemoTransport } from './demo-transport.js'

const TIMING = { stepMs: 10, wordMs: 5, thinkingWordMs: 2, toolMs: 20 }

let transport: DemoTransport
let events: Array<DataOf<'thread.event'>>
let queues: Array<DataOf<'thread.queue'>>

beforeEach(async () => {
  vi.useFakeTimers()
  transport = new DemoTransport({ latencyMs: 1, timing: TIMING, platform: 'linux' })
  events = []
  queues = []
  transport.on('thread.event', (data) => events.push(data))
  transport.on('thread.queue', (data) => queues.push(data))
  transport.connect()
  await vi.advanceTimersByTimeAsync(1)
})

afterEach(() => {
  transport.close()
  transport.server.dispose()
  vi.useRealTimers()
})

/** Resolves a request while the fake clock runs, the way a socket reply arrives. */
async function call<T>(request: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(2)
  return request
}

async function newChat(provider: 'claude-code' | 'grok' = 'claude-code'): Promise<string> {
  const { projects } = await call(transport.request('projects.list', {}))
  const { threadId } = await call(
    transport.request('thread.start', { provider, workspacePath: projects[0]!.path }),
  )
  return threadId
}

function typesFor(threadId: string): string[] {
  return events
    .filter((entry) => entry.threadId === threadId)
    .map((entry) => entry.event.type)
    .filter((type) => type !== 'item.delta')
}

function completedTurn(threadId: string): Extract<DomainEvent, { type: 'turn.completed' }>[] {
  return events.flatMap((entry) =>
    entry.threadId === threadId && entry.event.type === 'turn.completed' ? [entry.event] : [],
  )
}

describe('DemoTransport', () => {
  it('streams a sent prompt word by word through the normal turn events', async () => {
    const threadId = await newChat()
    const sent = await call(
      transport.request('thread.sendTurn', {
        threadId,
        text: 'Make the sidebar quieter',
        clientSubmissionId: 'local:prompt-1',
      }),
    )
    expect(sent).toMatchObject({ queued: false })
    await vi.advanceTimersByTimeAsync(10_000)

    const types = typesFor(threadId)
    expect(types[0]).toBe('turn.started')
    expect(types.at(-1)).toBe('turn.completed')
    expect(types).toContain('item.started')
    expect(completedTurn(threadId).map((event) => event.status)).toEqual(['completed'])

    const items = events.flatMap((entry) =>
      entry.event.type === 'item.completed' && entry.threadId === threadId
        ? [entry.event.item]
        : [],
    )
    expect(items[0]).toMatchObject({ id: 'local:prompt-1', role: 'user' })
    expect(items.some((item) => item.type === 'tool_call')).toBe(true)
    const answer = items.find((item) => item.role === 'assistant')!
    expect(answer.phase).toBe('final_answer')
    const deltas = events.flatMap((entry) =>
      entry.event.type === 'item.delta' && entry.event.itemId === answer.id
        ? [entry.event.textDelta]
        : [],
    )
    expect(deltas.length).toBeGreaterThan(20)
    expect(deltas.join('')).toBe(answer.text)
    expect(answer.text).toContain('Make the sidebar quieter')

    // Every push carries the next position in the chat's log, as history replays it.
    const seqs = events.filter((entry) => entry.threadId === threadId).map((entry) => entry.seq)
    expect(seqs).toEqual(seqs.map((_, index) => index + 1))
    const history = await call(transport.request('thread.history', { threadId }))
    expect(history.running).toBe(false)
    expect(history.events.length).toBe(seqs.length)
  })

  it('stops a streaming turn and keeps what arrived so far', async () => {
    const threadId = await newChat()
    await call(transport.request('thread.sendTurn', { threadId, text: 'Write a long answer' }))
    await vi.advanceTimersByTimeAsync(400)
    expect(transport.server.isRunning(threadId)).toBe(true)

    await call(transport.request('thread.interrupt', { threadId }))
    expect(transport.server.isRunning(threadId)).toBe(false)
    expect(completedTurn(threadId).map((event) => event.status)).toEqual(['interrupted'])
    const count = events.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(events.length).toBe(count)

    const started = events.flatMap((entry) =>
      entry.event.type === 'item.started' && entry.threadId === threadId
        ? [entry.event.item.id]
        : [],
    )
    const completed = new Set(
      events.flatMap((entry) =>
        entry.event.type === 'item.completed' && entry.threadId === threadId
          ? [entry.event.item.id]
          : [],
      ),
    )
    expect(started.every((id) => completed.has(id))).toBe(true)
  })

  it('queues a prompt sent during a turn and starts it after that turn', async () => {
    const threadId = await newChat('grok')
    await call(transport.request('thread.sendTurn', { threadId, text: 'First' }))
    const queued = await call(
      transport.request('thread.sendTurn', { threadId, text: 'Second', clientSubmissionId: 'q-2' }),
    )
    expect(queued).toMatchObject({ queued: true, queuedTurn: { id: 'q-2', text: 'Second' } })
    expect(queues.at(-1)).toMatchObject({ threadId, items: [{ id: 'q-2' }], canSteer: false })

    await vi.advanceTimersByTimeAsync(20_000)
    expect(completedTurn(threadId).map((event) => event.status)).toEqual(['completed', 'completed'])
    expect(queues.at(-1)).toMatchObject({ threadId, items: [] })
  })

  it('steers a queued prompt into the running turn', async () => {
    const threadId = await newChat('claude-code')
    await call(transport.request('thread.sendTurn', { threadId, text: 'First' }))
    await call(
      transport.request('thread.sendTurn', {
        threadId,
        text: 'Use tokens',
        clientSubmissionId: 's-1',
      }),
    )
    await call(transport.request('thread.steerQueuedTurn', { threadId, queuedTurnId: 's-1' }))
    expect(queues.at(-1)).toMatchObject({ threadId, items: [], canSteer: true })

    await vi.advanceTimersByTimeAsync(20_000)
    const turns = completedTurn(threadId)
    expect(turns).toHaveLength(1)
    const steered = events.find(
      (entry) => entry.event.type === 'item.completed' && entry.event.item.id === 's-1',
    )
    expect(steered?.event).toMatchObject({ item: { role: 'user', turnId: turns[0]!.turnId } })
  })

  it('answers every startup read with data the protocol accepts', async () => {
    const { projects } = await call(transport.request('projects.list', {}))
    expect(projects.length).toBeGreaterThan(1)
    const { providers } = await call(transport.request('providers.list', {}))
    expect(providers.map((status) => status.id)).toEqual(['claude-code', 'codex', 'grok'])
    for (const { id } of providers) {
      const { models } = await call(transport.request('models.list', { provider: id }))
      expect(models.some((model) => model.isDefault)).toBe(true)
      await expect(call(transport.request('auth.status', { provider: id }))).resolves.toMatchObject(
        { signedIn: true },
      )
      await call(transport.request('usage.summary', { provider: id }))
      await call(
        transport.request('commands.list', { provider: id, projectPath: projects[0]!.path }),
      )
      await call(transport.request('skills.list', { provider: id, projectPath: projects[0]!.path }))
      await call(transport.request('mcp.list', { provider: id, projectPath: projects[0]!.path }))
    }
    for (const session of projects.flatMap((project) => project.sessions)) {
      const history = await call(transport.request('thread.history', { threadId: session.id }))
      expect(history.events.at(-1)?.event.type).toBe('turn.completed')
    }
    await call(transport.request('usage.history', { range: '30d' }))
    await call(transport.request('backgroundModel.settings', {}))
    await call(transport.request('accounts.list', {}))
    await call(transport.request('workspace.listDirectory', { projectPath: projects[0]!.path }))
    // A method the sandbox does not model answers when its reply is empty.
    await expect(
      call(transport.request('thread.close', { threadId: projects[0]!.sessions[0]!.id })),
    ).resolves.toEqual({})
  })

  it('stages a second Claude Code account only when asked, and keeps the pick', async () => {
    const claude = { provider: 'claude-code' } as const
    const single = await call(transport.request('accounts.list', claude))
    expect(single.accounts.map((account) => account.id)).toEqual(['default'])

    const several = new DemoTransport({ latencyMs: 1, severalAccounts: true, platform: 'linux' })
    several.connect()
    await vi.advanceTimersByTimeAsync(1)
    const listed = await call(several.request('accounts.list', claude))
    expect(listed.accounts.map((account) => account.label)).toEqual(['Default', 'Work'])

    const changed = vi.fn()
    several.on('accounts.changed', changed)
    await call(several.request('accounts.setActive', { ...claude, accountId: 'work-1a2b3c' }))
    expect(changed).toHaveBeenCalledWith(claude)
    const picked = await call(several.request('accounts.list', claude))
    expect(picked.active).toEqual({ 'claude-code': 'work-1a2b3c' })

    const { projects } = await call(several.request('projects.list', {}))
    const started = await call(
      several.request('thread.start', { ...claude, workspacePath: projects[0]!.path }),
    )
    const after = await call(several.request('projects.list', {}))
    const chat = after.projects[0]!.sessions.find((session) => session.id === started.threadId)
    expect(chat?.accountId).toBe('work-1a2b3c')
    several.close()
    several.server.dispose()
  })

  it('fails requests still waiting when it closes, like the socket transport', async () => {
    const pending = transport.request('providers.list', {})
    transport.close()
    await expect(pending).rejects.toThrow('closed')
    await expect(transport.request('providers.list', {})).rejects.toThrow('closed')
  })
})
