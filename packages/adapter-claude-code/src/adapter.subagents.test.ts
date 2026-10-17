import { readFileSync } from 'node:fs'
import type {
  McpServerStatus,
  SDKControlInitializeResponse,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { DomainEvent, Item, Subagent } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reduce, emptyThread } from '../../../apps/web/src/thread-store.js'
import { ClaudeCodeAdapter, CLAUDE_CAPABILITIES } from './adapter.js'
import type { ClaudeQueryFactory, ClaudeQueryRuntime } from './sdk-runtime.js'

/**
 * Captured from claude 2.1.296 through the Agent SDK: one turn that starts a foreground
 * Explore agent and a run_in_background general-purpose agent, then the run Claude starts
 * by itself when the background agent reports. The init message is trimmed to what the
 * adapter reads and local paths are replaced.
 */
const captured = readFileSync(
  new URL('./fixtures/subagent-claude-2.1.296.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    const entry = JSON.parse(line) as { message?: SDKMessage }
    return entry.message ? [entry.message] : []
  })

const FOREGROUND = 'toolu_01H2ohrcMYG9HG3ePSQ7yz9z'
const BACKGROUND = 'toolu_013q1DPbqKe2X5zc1rEpXizW'
/** Tool calls the two agents made in their own conversations. */
const SIDECHAIN_CALLS = ['toolu_016SoK5QTZgY9xupf25maqS3', 'toolu_01KHyNxiQJBDghdLnMMv6spf']

class FakeQuery implements ClaudeQueryRuntime {
  readonly #messages: SDKMessage[] = []
  readonly #waiters: Array<(value: IteratorResult<SDKMessage>) => void> = []
  #closed = false

  emitMessage(message: SDKMessage): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: message, done: false })
    else this.#messages.push(message)
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  async interrupt() {
    return undefined
  }

  async setModel(): Promise<void> {}

  async setPermissionMode(): Promise<void> {}

  async supportedModels() {
    return []
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return []
  }

  async setMcpServers() {
    return { added: [], removed: [], errors: {} }
  }

  async initializationResult(): Promise<SDKControlInitializeResponse> {
    return {
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: [],
      models: [],
      account: {},
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.#messages.shift()
        if (message) return Promise.resolve({ value: message, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const adapters: ClaudeCodeAdapter[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
})

async function session() {
  let query: FakeQuery | undefined
  const createQuery: ClaudeQueryFactory = () => (query = new FakeQuery())
  const adapter = new ClaudeCodeAdapter({ createQuery })
  adapters.push(adapter)
  const events: DomainEvent[] = []
  adapter.on('event', (event) => events.push(event))
  const thread = await adapter.startThread('C:\\project')
  const turnId = await adapter.sendTurn(thread.id, 'Start two agents')
  const replay = async (messages: SDKMessage[]) => {
    for (const message of messages) query!.emitMessage(message)
    await tick()
  }
  /** One message a second, with fake timers, so every throttled update goes out. */
  const replaySlowly = async (messages: SDKMessage[]) => {
    for (const message of messages) {
      query!.emitMessage(message)
      await tick()
      vi.advanceTimersByTime(1_000)
    }
  }
  return { adapter, events, turnId, replay, replaySlowly, query: () => query! }
}

/** Every item event for one tool call, in order. */
function itemsFor(events: DomainEvent[], toolUseId: string): Item[] {
  return events.flatMap((event) =>
    (event.type === 'item.started' || event.type === 'item.completed') &&
    event.item.id === `${toolUseId}-call`
      ? [event.item]
      : [],
  )
}

const index = (predicate: (message: SDKMessage & Record<string, unknown>) => boolean) =>
  captured.findIndex((message) => predicate(message as SDKMessage & Record<string, unknown>))

describe('Claude subagents', () => {
  it('declares progress reporting', () => {
    expect(CLAUDE_CAPABILITIES.subagents).toBe('progress')
  })

  it('reports both captured agents with identity, progress and result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { events, replaySlowly } = await session()
    await replaySlowly(captured)

    const foreground = itemsFor(events, FOREGROUND)
    const background = itemsFor(events, BACKGROUND)
    // The store replaces an item whole, so every send of the call carries its agent.
    expect(foreground.every((item) => item.subagent?.id === FOREGROUND)).toBe(true)
    expect(background.every((item) => item.subagent?.id === BACKGROUND)).toBe(true)
    expect(foreground.at(-1)).toMatchObject({
      type: 'tool_call',
      status: 'completed',
      subagent: {
        id: FOREGROUND,
        name: 'Explore',
        description: 'Count files',
        state: 'completed',
        toolUses: 1,
        tokens: 22_432,
        durationMs: 3_618,
        lastTool: 'Glob',
        summary: '3',
      } satisfies Subagent,
    })
    expect(foreground.at(-1)!.subagent).not.toHaveProperty('background')
    expect(background.at(-1)).toMatchObject({
      status: 'completed',
      subagent: {
        id: BACKGROUND,
        name: 'general-purpose',
        description: 'Read notes',
        state: 'completed',
        background: true,
        toolUses: 1,
        tokens: 34_733,
        durationMs: 4_466,
        lastTool: 'Read',
        summary: 'Tiny scratch project for a subagent capture.',
      } satisfies Subagent,
    })
    // The background call returns at once; its agent keeps running after that.
    expect(background).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        subagent: expect.objectContaining({ state: 'running', lastTool: 'Read' }),
      }),
    )
    // A progress step names what the agent is doing until its report arrives.
    expect(foreground).toContainEqual(
      expect.objectContaining({
        subagent: expect.objectContaining({ state: 'running', summary: 'Finding *' }),
      }),
    )

    const ids = events.flatMap((event) =>
      event.type === 'item.started' || event.type === 'item.completed' ? [event.item.id] : [],
    )
    for (const call of SIDECHAIN_CALLS) expect(ids.some((id) => id.startsWith(call))).toBe(false)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(2)

    const state = events.reduce(reduce, emptyThread)
    expect(state.items.find((item) => item.id === `${FOREGROUND}-call`)?.subagent).toMatchObject({
      state: 'completed',
      summary: '3',
    })
    expect(state.items.find((item) => item.id === `${BACKGROUND}-call`)?.subagent).toMatchObject({
      state: 'completed',
      background: true,
    })
  })

  it('sends a task message only when it changes what the row shows', async () => {
    const { events, replay } = await session()
    await replay(captured)
    // Replayed at once, progress folds into the final report: the call's own sends plus that.
    expect(itemsFor(events, FOREGROUND).map((item) => [item.status, item.subagent?.state])).toEqual(
      [
        ['started', 'running'],
        ['started', 'running'],
        ['started', 'completed'],
        ['completed', 'completed'],
      ],
    )
    expect(itemsFor(events, BACKGROUND).map((item) => [item.status, item.subagent?.state])).toEqual(
      [
        ['started', 'running'],
        ['started', 'running'],
        ['completed', 'running'],
        ['completed', 'completed'],
      ],
    )
  })

  it('ends a foreground agent with the turn it was stopped in', async () => {
    const { adapter, events, replay, turnId } = await session()
    await replay(
      captured.slice(
        0,
        index((message) => message.subtype === 'task_updated'),
      ),
    )
    await adapter.interrupt()
    const result = captured[index((message) => message.type === 'result')]!
    await replay([
      {
        ...result,
        is_error: true,
        subtype: 'error_during_execution',
        errors: ['aborted'],
      } as SDKMessage,
    ])

    expect(events).toContainEqual({ type: 'turn.completed', turnId, status: 'interrupted' })
    expect(itemsFor(events, FOREGROUND).at(-1)).toMatchObject({
      status: 'failed',
      subagent: { state: 'interrupted', toolUses: 1, lastTool: 'Glob' },
    })
    // A background agent outlives the turn that started it.
    expect(itemsFor(events, BACKGROUND).at(-1)).toMatchObject({
      subagent: { state: 'running', background: true },
    })
  })

  it('leaves agents that already reported alone when the session closes', async () => {
    const { adapter, events, replay } = await session()
    await replay(captured.slice(0, index((message) => message.type === 'result') + 1))
    const before = events.length
    await adapter.dispose()
    expect(itemsFor(events.slice(before), FOREGROUND)).toEqual([])
    expect(itemsFor(events.slice(before), BACKGROUND)).toEqual([])
  })

  it('closes a background agent still running as interrupted', async () => {
    const { adapter, events, replay } = await session()
    const report = index(
      (message) => message.subtype === 'task_updated' && message.task_id === 'ad5eb828797c51a09',
    )
    await replay(captured.slice(0, report))
    expect(itemsFor(events, BACKGROUND).at(-1)).toMatchObject({
      status: 'completed',
      subagent: { state: 'running' },
    })
    await adapter.dispose()
    expect(itemsFor(events, BACKGROUND).at(-1)).toMatchObject({
      status: 'completed',
      subagent: { state: 'interrupted', background: true },
    })
  })

  it('sends progress at most once a second, then the latest numbers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { events, replay } = await session()
    const started = index((message) => message.subtype === 'task_started')
    await replay(captured.slice(0, started + 1))
    const sent = () => itemsFor(events, FOREGROUND).length
    const afterStart = sent()
    const progress = captured[index((message) => message.subtype === 'task_progress')]!
    const step = (toolUses: number) =>
      ({
        ...progress,
        usage: { total_tokens: 20_000 + toolUses, tool_uses: toolUses, duration_ms: 100 },
      }) as SDKMessage
    await replay([step(1), step(2), step(3)])
    expect(sent()).toBe(afterStart)

    vi.advanceTimersByTime(999)
    expect(sent()).toBe(afterStart)
    vi.advanceTimersByTime(1)
    expect(sent()).toBe(afterStart + 1)
    expect(itemsFor(events, FOREGROUND).at(-1)?.subagent).toMatchObject({ toolUses: 3 })
  })

  it('fails an agent call that ended before Claude started it', async () => {
    const { events, replay } = await session()
    await replay([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        session_id: 'session',
        message: {
          id: 'message-task',
          role: 'assistant',
          type: 'message',
          model: 'claude-sonnet-5-5',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_task',
              name: 'Task',
              input: { subagent_type: 'Missing', description: 'Look around', prompt: 'Go' },
            },
          ],
        },
      } as unknown as SDKMessage,
      {
        type: 'user',
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        session_id: 'session',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_task',
              content: 'Agent type not found',
              is_error: true,
            },
          ],
        },
      } as unknown as SDKMessage,
    ])
    expect(itemsFor(events, 'toolu_task').at(-1)).toMatchObject({
      status: 'failed',
      subagent: { id: 'toolu_task', name: 'Missing', description: 'Look around', state: 'failed' },
    })
  })
})
