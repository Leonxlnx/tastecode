import { describe, expect, it } from 'vitest'
import type { Capabilities, DomainEvent, ProviderId } from '@harness/contracts'
import type { AgentSession, ProviderRuntime } from './adapters.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'

/**
 * What must stay true when several sessions run at once.
 *
 * Verified against two real Claude Code sessions before these were written —
 * both turns dispatched in 27ms and neither saw the other's output. These
 * exist so that stays true: the tempting future change is a shared lock or a
 * single reused adapter, and either would pass every other test in the repo.
 */

const CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: false,
}

/** A session that answers when told to, so turns can be interleaved by hand. */
class FakeSession implements AgentSession {
  readonly capabilities = CAPABILITIES
  emit: (event: DomainEvent) => void = () => {}
  disposed = false
  /** Resolves the pending sendTurn, letting a test hold one open. */
  release: (() => void) | undefined

  #listeners: Array<(event: DomainEvent) => void> = []

  constructor(readonly id: string) {}

  async sendTurn(_threadId: string, _text: string): Promise<string> {
    if (this.release) await new Promise<void>((resolve) => (this.release = resolve))
    return `${this.id}-turn`
  }

  async interrupt(): Promise<void> {}
  respondToApproval(): void {}
  dispose(): void {
    this.disposed = true
  }

  on(_event: 'event' | 'log', listener: (value: never) => void): void {
    this.#listeners.push(listener as (event: DomainEvent) => void)
    this.emit = (event) => {
      for (const l of this.#listeners) l(event)
    }
  }
}

function harness() {
  const store = new Store(':memory:')
  const sessions: FakeSession[] = []
  const received: Array<{ threadId: string; event: DomainEvent }> = []

  const runtimeFor = (): ProviderRuntime => ({
    async start(workspacePath) {
      const session = new FakeSession(`s${sessions.length + 1}`)
      sessions.push(session)
      return {
        thread: {
          id: `thread-${sessions.length}`,
          provider: 'codex' as ProviderId,
          workspacePath,
          createdAt: Date.now(),
        },
        session,
      }
    },
    async listModels() {
      return []
    },
  })

  const orchestrator = new Orchestrator(store, {
    onEvent: (threadId, event) => received.push({ threadId, event }),
    onLog: () => {},
    onLogin: () => {},
    runtimeFor,
  })

  return { store, sessions, received, orchestrator }
}

const message = (text: string): DomainEvent => ({
  type: 'item.completed',
  item: {
    id: `i-${text}`,
    turnId: 't1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: 0,
  },
})

describe('several sessions at once', () => {
  it('gives each session its own agent rather than sharing one', async () => {
    const { sessions, orchestrator } = harness()

    await orchestrator.startThread('codex', '/repo')
    await orchestrator.startThread('codex', '/repo')

    // One adapter driving two threads would interleave two conversations into
    // one context, which is the failure this guards against.
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).not.toBe(sessions[1])
  })

  it('does not let a turn in one session block another', async () => {
    const { sessions, orchestrator } = harness()

    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')

    // Hold the first turn open indefinitely.
    sessions[0]!.release = () => {}
    void orchestrator.sendTurn(first.id, 'slow one')

    // The second must still get through. A shared lock would hang here.
    await expect(orchestrator.sendTurn(second.id, 'quick one')).resolves.toBe('s2-turn')
  })

  it('routes each session events to its own thread', async () => {
    const { sessions, received, orchestrator } = harness()

    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')

    sessions[0]!.emit(message('ALPHA'))
    sessions[1]!.emit(message('BRAVO'))

    const forFirst = received.filter((entry) => entry.threadId === first.id)
    const forSecond = received.filter((entry) => entry.threadId === second.id)
    expect(text(forFirst)).toEqual(['ALPHA'])
    expect(text(forSecond)).toEqual(['BRAVO'])
  })

  it('keeps each session history separate on disk too', async () => {
    const { sessions, store, orchestrator } = harness()

    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')

    sessions[0]!.emit(message('ALPHA'))
    sessions[1]!.emit(message('BRAVO'))

    expect(store.history(first.id)).toHaveLength(1)
    expect(store.history(second.id)).toHaveLength(1)
  })

  it('closing one session leaves the other running', async () => {
    const { sessions, orchestrator } = harness()

    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')

    orchestrator.close(first.id)

    expect(sessions[0]!.disposed).toBe(true)
    expect(sessions[1]!.disposed).toBe(false)
    expect(orchestrator.isRunning(first.id)).toBe(false)
    expect(orchestrator.isRunning(second.id)).toBe(true)
  })

  it('a closed session keeps its history and stops claiming to run', async () => {
    const { sessions, store, orchestrator } = harness()

    const thread = await orchestrator.startThread('codex', '/repo')
    sessions[0]!.emit(message('ALPHA'))
    orchestrator.close(thread.id)

    expect(orchestrator.isRunning(thread.id)).toBe(false)
    expect(store.history(thread.id)).toHaveLength(1)
    expect(store.thread(thread.id)?.closedAt).toBeGreaterThan(0)
  })
})

function text(entries: Array<{ event: DomainEvent }>): Array<string | undefined> {
  return entries
    .filter((entry) => entry.event.type === 'item.completed')
    .map((entry) => (entry.event.type === 'item.completed' ? entry.event.item.text : undefined))
}
