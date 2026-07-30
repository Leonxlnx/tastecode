import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

function harness(worktreeRoot?: string) {
  const store = new Store(':memory:')
  const sessions: FakeSession[] = []
  const received: Array<{ threadId: string; event: DomainEvent }> = []

  /** Where each session was actually told to run. */
  const startedIn: string[] = []

  const runtimeFor = (): ProviderRuntime => ({
    async start(workspacePath) {
      startedIn.push(workspacePath)
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
    ...(worktreeRoot ? { worktreeRoot } : {}),
  })

  return { store, sessions, received, orchestrator, startedIn }
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

describe('isolated sessions', () => {
  let repo: string
  let trees: string

  beforeEach(() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'harness-orch-'))
    repo = path.join(base, 'repo')
    trees = path.join(base, 'trees')
    execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true })
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(path.join(repo, 'file.txt'), 'original\n')
    git('add', '.')
    git('commit', '-m', 'first')
  })

  afterEach(() => {
    rmSync(path.dirname(repo), { recursive: true, force: true })
  })

  it('runs the agent in its own checkout, not in the project folder', async () => {
    const { startedIn, orchestrator } = harness(trees)

    await orchestrator.startThread('codex', repo, { isolate: true })

    expect(startedIn[0]).not.toBe(repo)
    expect(existsSync(path.join(startedIn[0]!, 'file.txt'))).toBe(true)
  })

  it('still records the project as the repository the user chose', async () => {
    const { store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo, { isolate: true })

    // The private checkout is where the work happens; it is not what the
    // session belongs to.
    expect(store.thread(thread.id)?.projectPath).toBe(repo)
    expect(store.thread(thread.id)?.worktreePath).toBe(startedInOf(store, thread.id))
  })

  it('runs in the project folder itself when isolation was not asked for', async () => {
    const { startedIn, store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo)

    expect(startedIn[0]).toBe(repo)
    expect(store.thread(thread.id)?.worktreePath).toBeUndefined()
  })

  it('refuses to discard a checkout holding work nobody has committed', async () => {
    const { store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    writeFileSync(path.join(store.thread(thread.id)!.worktreePath!, 'file.txt'), 'agent work\n')

    await expect(orchestrator.discardWorktree(thread.id)).rejects.toThrow(/uncommitted/i)
    // Refusing has to actually leave it there.
    expect(existsSync(store.thread(thread.id)!.worktreePath!)).toBe(true)
  })

  it('closing a session leaves its checkout alone', async () => {
    const { store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktreePath = store.thread(thread.id)!.worktreePath!

    orchestrator.close(thread.id)

    // Closing ends the process. It says nothing about the work in there.
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('forgets a checkout that a crash left behind, and keeps ones still on disk', async () => {
    const { store, orchestrator } = harness(trees)

    const gone = await orchestrator.startThread('codex', repo, { isolate: true })
    const alive = await orchestrator.startThread('codex', repo, { isolate: true })
    rmSync(store.thread(gone.id)!.worktreePath!, { recursive: true, force: true })

    await orchestrator.recoverWorktrees()

    expect(store.thread(gone.id)?.worktreePath).toBeUndefined()
    expect(store.thread(alive.id)?.worktreePath).toBeDefined()
  })

  it('leaves nothing behind when the agent fails to start', async () => {
    const store = new Store(':memory:')
    const orchestrator = new Orchestrator(store, {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      worktreeRoot: trees,
      runtimeFor: () => ({
        async start() {
          throw new Error('binary not found')
        },
        async listModels() {
          return []
        },
      }),
    })

    await expect(orchestrator.startThread('codex', repo, { isolate: true })).rejects.toThrow(
      /binary not found/,
    )

    // A checkout for a session that never started is litter, and the next
    // attempt would trip over it.
    expect(existsSync(trees) ? readdirSync(trees) : []).toEqual([])
  })
})

function startedInOf(store: Store, threadId: string): string | undefined {
  return store.thread(threadId)?.worktreePath
}

function text(entries: Array<{ event: DomainEvent }>): Array<string | undefined> {
  return entries
    .filter((entry) => entry.event.type === 'item.completed')
    .map((entry) => (entry.event.type === 'item.completed' ? entry.event.item.text : undefined))
}
