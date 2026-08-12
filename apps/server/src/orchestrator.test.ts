import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderIdSchema } from '@harness/contracts'
import type {
  ApprovalMode,
  Capabilities,
  DomainEvent,
  McpServer,
  ProviderId,
  ThreadLifecycle,
} from '@harness/contracts'
import type { AgentSession, ProviderRuntime, StartOptions, TurnOptions } from './adapters.js'
import { DESIGN_BRIEF_ATTACHMENT, writeDesignBrief } from '@harness/design-agent'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'
import * as checkpoint from './checkpoint.js'
import { beginOptimisticTurn, emptyThread, reduceEventLog } from '../../web/src/thread-store.js'
import { presentTurns } from '../../web/src/ui/turns.js'

/** Counts stops, so tests can prove the dev server does not outlive its flow. */
const previewStops = vi.hoisted(() => ({ count: 0 }))

vi.mock('./design-preview-runner.js', () => ({
  startDesignPreview: vi.fn(
    async (_workspace: string, plan: { url: string; viewports: unknown[] }) => ({
      url: plan.url,
      viewports: plan.viewports,
      output: () => 'ready',
      stop: async () => {
        previewStops.count += 1
      },
    }),
  ),
}))

/**
 * What must stay true when several sessions run at once.
 *
 * Verified against two real Claude Code sessions before these were written —
 * both turns dispatched in 27ms and neither saw the other's output. These
 * exist so that stays true: the tempting future change is a shared lock or a
 * single reused adapter, and either would pass every other test in the repo.
 */

const CAPABILITIES: Capabilities = {
  steer: true,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: true,
}

/** A session that answers when told to, so turns can be interleaved by hand. */
class FakeSession implements AgentSession {
  readonly capabilities = CAPABILITIES
  emit: (event: DomainEvent) => void = () => {}
  disposed = false
  interrupted = false
  interruptBarrier: Promise<void> | undefined
  interruptError: Error | undefined
  sent: string[] = []
  sentAttachments: string[][] = []
  sentOptions: Array<TurnOptions | undefined> = []
  steered: string[] = []
  userInputs: Array<{ requestId: string; answers: Record<string, string[]> }> = []
  approvalModes: ApprovalMode[] = []
  mcpServers: McpServer[] = []
  turnIds: string[] = []
  sendError: Error | undefined
  eventDuringSend: DomainEvent | undefined
  emitUsageChanged: () => void = () => {}
  afterEventBarrier: Promise<void> | undefined
  steerBarriers: Promise<void>[] = []
  /** Resolves the pending sendTurn, letting a test hold one open. */
  release: (() => void) | undefined

  #listeners: Array<(event: DomainEvent) => void> = []

  constructor(readonly id: string) {}

  async sendTurn(
    _threadId: string,
    text: string,
    attachments: string[] = [],
    options?: TurnOptions,
  ): Promise<string> {
    this.sent.push(text)
    this.sentAttachments.push(attachments)
    this.sentOptions.push(options)
    if (this.release) await new Promise<void>((resolve) => (this.release = resolve))
    if (this.sendError) throw this.sendError
    if (this.eventDuringSend) this.emit(this.eventDuringSend)
    if (this.afterEventBarrier) await this.afterEventBarrier
    return this.turnIds.shift() ?? `${this.id}-turn`
  }

  async steer(_threadId: string, text: string): Promise<void> {
    this.steered.push(text)
    const barrier = this.steerBarriers.shift()
    if (barrier) await barrier
  }

  async interrupt(_threadId: string): Promise<void> {
    this.interrupted = true
    await this.interruptBarrier
    if (this.interruptError) throw this.interruptError
  }
  async listMcpServers(): Promise<McpServer[]> {
    return this.mcpServers
  }
  respondToApproval(): void {}
  respondToUserInput(requestId: string, answers: Record<string, string[]>): void {
    this.userInputs.push({ requestId, answers })
  }
  setApproval(approval: ApprovalMode): void {
    this.approvalModes.push(approval)
  }
  dispose(): void {
    this.disposed = true
  }

  on(_event: 'event' | 'log', listener: (value: never) => void): void {
    this.#listeners.push(listener as (event: DomainEvent) => void)
    this.emit = (event) => {
      for (const l of this.#listeners) l(event)
    }
  }

  onUsageChanged(listener: () => void): void {
    this.emitUsageChanged = listener
  }
}

function harness(worktreeRoot?: string, store = new Store(':memory:')) {
  const sessions: FakeSession[] = []
  const received: Array<{ threadId: string; event: DomainEvent }> = []
  const lifecycles: Array<{ threadId: string; lifecycle: ThreadLifecycle }> = []
  const logs: string[] = []
  const queueChanges: Array<{ threadId: string; itemIds: string[] }> = []
  const usageChanges: ProviderId[] = []
  const queueNotificationError: { current?: Error } = {}

  /** Where each session was actually told to run. */
  const startedIn: string[] = []
  const startedOptions: StartOptions[] = []
  const resumedIds: string[] = []
  const resumedIn: string[] = []
  const resumedOptions: StartOptions[] = []
  const capturePreview = vi.fn(
    async (_url: string, viewports: Array<{ width: number; height: number }>) =>
      viewports.map((viewport) => ({
        path: path.join(os.tmpdir(), `${viewport.width}x${viewport.height}.png`),
        ...viewport,
      })),
  )

  const runtimeFor = (provider: ProviderId): ProviderRuntime => ({
    async start(workspacePath, options) {
      startedIn.push(workspacePath)
      startedOptions.push(options)
      const session = new FakeSession(`s${sessions.length + 1}`)
      sessions.push(session)
      return {
        thread: {
          id: `thread-${sessions.length}`,
          provider,
          ...(provider === 'api' ? { connectionId: 'test-connection' } : {}),
          workspacePath,
          createdAt: Date.now(),
        },
        session,
      }
    },
    async listModels() {
      return []
    },
    ...(provider === 'codex'
      ? {
          async resume(threadId: string, workspacePath: string, options: StartOptions) {
            resumedIds.push(threadId)
            resumedIn.push(workspacePath)
            resumedOptions.push(options)
            const session = new FakeSession(`s${sessions.length + 1}`)
            sessions.push(session)
            return {
              thread: {
                id: threadId,
                provider,
                workspacePath,
                createdAt: Date.now(),
              },
              session,
            }
          },
        }
      : {}),
  })

  const orchestrator = new Orchestrator(store, {
    onEvent: (threadId, event) => received.push({ threadId, event }),
    onQueue: (threadId, state) => {
      queueChanges.push({ threadId, itemIds: state.items.map(({ id }) => id) })
      if (queueNotificationError.current) throw queueNotificationError.current
    },
    onLifecycle: (threadId, lifecycle) => lifecycles.push({ threadId, lifecycle }),
    onLog: (line) => logs.push(line),
    onLogin: () => {},
    onUsageChanged: (provider) => usageChanges.push(provider),
    mcpConfig: new McpConfigStore(
      path.join(mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-')), 'mcp.json'),
    ),
    readCredential: (reference) => `secret:${reference}`,
    capturePreview,
    runtimeFor,
    ...(worktreeRoot ? { worktreeRoot } : {}),
  })

  return {
    store,
    sessions,
    received,
    lifecycles,
    logs,
    queueChanges,
    usageChanges,
    queueNotificationError,
    orchestrator,
    startedIn,
    startedOptions,
    resumedIds,
    resumedIn,
    resumedOptions,
    capturePreview,
  }
}

describe('provider usage changes', () => {
  it('forwards a live session signal with its provider identity', async () => {
    const { orchestrator, sessions, usageChanges } = harness()
    await orchestrator.startThread('codex', process.cwd())

    sessions[0]?.emitUsageChanged()

    expect(usageChanges).toEqual(['codex'])
  })
})

const message = (text: string, turnId = 't1'): DomainEvent => ({
  type: 'item.completed',
  item: {
    id: `i-${text}`,
    turnId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: 0,
  },
})

const userMessage = (
  id: string,
  text: string,
  turnId: string,
  status: 'started' | 'completed' = 'completed',
): DomainEvent => ({
  type: status === 'started' ? 'item.started' : 'item.completed',
  item: {
    id,
    turnId,
    type: 'message',
    role: 'user',
    status,
    text,
    createdAt: 0,
  },
})
const turnStarted = (threadId: string, turnId: string): DomainEvent => ({
  type: 'turn.started',
  turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
})
describe('structured user input', () => {
  it('returns answers to the session that owns the waiting request', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', process.cwd(), {})

    orchestrator.respondToUserInput(thread.id, 'brief-1', {
      palette: ['Decide for me'],
    })

    expect(sessions[0]?.userInputs).toEqual([
      { requestId: 'brief-1', answers: { palette: ['Decide for me'] } },
    ])
  })
})

describe('live access level', () => {
  it('records the new mode and forwards it to the session', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', process.cwd(), { approval: 'ask' })

    orchestrator.setThreadApproval(thread.id, 'full')

    expect(sessions[0]?.approvalModes).toEqual(['full'])
  })

  it('throws for a thread it does not know', async () => {
    const { orchestrator } = harness()

    expect(() => orchestrator.setThreadApproval('missing-thread', 'auto')).toThrow(/no such thread/)
  })
})

describe('reply style', () => {
  it.each(ProviderIdSchema.options)(
    'starts %s with the shared reply instructions',
    async (provider) => {
      const { orchestrator, startedOptions } = harness()
      await orchestrator.startThread(provider, process.cwd())

      expect(startedOptions[0]?.instructions).toContain('clear, capable teammate')
      expect(startedOptions[0]?.instructions).toContain('Do not use em dashes')
    },
  )
})

describe('workspace paths', () => {
  it('expands a home-relative project before starting Grok and taking checkpoints', async () => {
    const projectPath = ['~', 'Developer', 'harness'].join(path.sep)
    const resolvedPath = path.join(os.homedir(), 'Developer', 'harness')
    const { orchestrator, startedIn, store } = harness()
    const snapshot = vi
      .spyOn(checkpoint, 'takeSnapshot')
      .mockResolvedValueOnce({ commit: 'checkpoint', clean: true })

    const thread = await orchestrator.startThread('grok', projectPath)
    await orchestrator.sendTurn(thread.id, 'hello')

    expect(startedIn).toEqual([resolvedPath])
    expect(snapshot).toHaveBeenCalledWith(resolvedPath)
    expect(store.thread(thread.id)?.projectPath).toBe(projectPath)
    await orchestrator.disposeAll()
  })
})

describe('durable turn timing', () => {
  it('replays the accepted start after a provider reports a later timestamp', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const optimistic = beginOptimisticTurn(emptyThread, 'Do the work.')
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('api', '/repo')
      const session = sessions[0]!
      session.turnIds.push('turn-replay')
      await orchestrator.sendTurn(thread.id, 'Do the work.')

      now.mockReturnValue(5_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'turn-replay', threadId: thread.id, status: 'running', createdAt: 5_000 },
      })
      now.mockReturnValue(8_000)
      const answer = message('Done.', 'turn-replay')
      if (answer.type !== 'item.completed') throw new Error('expected completed message')
      session.emit({ ...answer, item: { ...answer.item, createdAt: 8_000 } })
      session.emit({ type: 'turn.completed', turnId: 'turn-replay', status: 'completed' })

      const history = store.history(thread.id)
      const replayed = reduceEventLog(emptyThread, history)
      const live = reduceEventLog(optimistic, history)
      expect(replayed.turnTiming['turn-replay']).toEqual({ startedAt: 1_000, completedAt: 8_000 })
      expect(
        [live, replayed].map(
          (state) => presentTurns(state.items, state.turnTiming).get('turn-replay')?.elapsedMs,
        ),
      ).toEqual([7_000, 7_000])
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
    }
  })

  it('normalizes a start emitted before the provider returns its turn id', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('api', '/repo')
      const session = sessions[0]!
      session.turnIds.push('turn-sync')
      session.eventDuringSend = {
        type: 'turn.started',
        turn: { id: 'turn-sync', threadId: thread.id, status: 'running', createdAt: 5_000 },
      }

      await orchestrator.sendTurn(thread.id, 'Do the work.')

      expect(store.history(thread.id).at(-1)?.event).toMatchObject({
        type: 'turn.started',
        turn: { id: 'turn-sync', createdAt: 1_000 },
      })
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
    }
  })

  it.each(['codex', 'api'] as const)(
    'records server-owned lifecycle boundaries for %s turns',
    async (provider) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const { orchestrator, sessions, store, received } = harness()
      try {
        const thread = await orchestrator.startThread(provider, '/repo')
        const session = sessions[0]!
        session.turnIds.push('turn-1')
        await orchestrator.sendTurn(thread.id, 'Do the work.')

        now.mockReturnValue(5_000)
        session.emit({
          type: 'turn.started',
          turn: { id: 'turn-1', threadId: thread.id, status: 'running', createdAt: 5_000 },
        })
        now.mockReturnValue(32_000)
        session.emit({
          type: 'turn.completed',
          turnId: 'turn-1',
          status: 'completed',
          completedAt: 4_000,
        })

        const lifecycle = store
          .history(thread.id)
          .map(({ event }) => event)
          .filter((event) => event.type === 'turn.started' || event.type === 'turn.completed')
        expect(lifecycle).toEqual([
          {
            type: 'turn.started',
            turn: { id: 'turn-1', threadId: thread.id, status: 'running', createdAt: 1_000 },
          },
          {
            type: 'turn.completed',
            turnId: 'turn-1',
            status: 'completed',
            completedAt: 32_000,
          },
        ])
        expect(received.map(({ event }) => event).slice(-2)).toEqual(lifecycle)
      } finally {
        now.mockRestore()
        await orchestrator.disposeAll()
      }
    },
  )

  it('anchors queued and design turns when their provider work actually starts', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds.push('first', 'queued', 'design')
      await orchestrator.submitTurn(thread.id, 'First')
      await orchestrator.submitTurn(thread.id, 'Queued')

      now.mockReturnValue(5_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'first', threadId: thread.id, status: 'running', createdAt: 5_000 },
      })
      now.mockReturnValue(7_000)
      session.emit({ type: 'turn.completed', turnId: 'first', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toEqual(['First', 'Queued']))
      now.mockReturnValue(9_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'queued', threadId: thread.id, status: 'running', createdAt: 9_000 },
      })
      session.emit({ type: 'turn.completed', turnId: 'queued', status: 'completed' })

      now.mockReturnValue(11_000)
      await orchestrator.sendTurn(thread.id, 'Design', [DESIGN_BRIEF_ATTACHMENT])
      now.mockReturnValue(13_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'design', threadId: thread.id, status: 'running', createdAt: 13_000 },
      })

      const starts = store
        .history(thread.id)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'turn.started' }> =>
            event.type === 'turn.started',
        )
      expect(starts.map(({ turn }) => [turn.id, turn.createdAt])).toEqual([
        ['first', 1_000],
        ['queued', 7_000],
        ['design', 11_000],
      ])
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
    }
  })

  it('does not reuse failed or disposed turn anchors', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const session = sessions[0]!
    try {
      session.sendError = new Error('provider rejected the turn')
      await expect(orchestrator.sendTurn(thread.id, 'Fails')).rejects.toThrow('provider rejected')

      session.sendError = undefined
      session.turnIds.push('after-failure', 'before-error', 'before-dispose')
      now.mockReturnValue(2_000)
      await orchestrator.sendTurn(thread.id, 'Retry')
      now.mockReturnValue(5_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'after-failure', threadId: thread.id, status: 'running', createdAt: 5_000 },
      })

      now.mockReturnValue(6_000)
      await orchestrator.sendTurn(thread.id, 'Errors')
      session.emit({ type: 'thread.error', threadId: thread.id, message: 'provider failed' })
      now.mockReturnValue(7_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'before-error', threadId: thread.id, status: 'running', createdAt: 7_000 },
      })

      now.mockReturnValue(8_000)
      await orchestrator.sendTurn(thread.id, 'Dispose')
      await orchestrator.disposeAll()
      now.mockReturnValue(9_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'before-dispose', threadId: thread.id, status: 'running', createdAt: 9_000 },
      })

      const starts = store
        .history(thread.id)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'turn.started' }> =>
            event.type === 'turn.started',
        )
      expect(starts.map(({ turn }) => turn.createdAt)).toEqual([2_000, 7_000, 9_000])
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
    }
  })
})

describe('durable user submissions', () => {
  it.each([
    ['codex', true],
    ['claude-code', false],
    ['grok', false],
    ['api', false],
  ] as const)('owns exact repeated user messages for %s', async (provider, emitsUserEcho) => {
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread(provider, '/repo')
      const session = sessions[0]!
      for (const [turnId, submissionId] of [
        ['turn-a', 'submission-a'],
        ['turn-b', 'submission-b'],
      ] as const) {
        session.turnIds.push(turnId)
        await orchestrator.submitTurn(thread.id, 'Repeat this.', [], {}, submissionId)
        expect(store.hasItem(thread.id, submissionId)).toBe(true)
        session.emit(turnStarted(thread.id, turnId))
        if (emitsUserEcho) {
          session.emit(userMessage(`provider-${submissionId}`, 'Repeat this.', turnId, 'started'))
          session.emit({
            type: 'item.delta',
            turnId,
            itemId: `provider-${submissionId}`,
            textDelta: 'Repeat this.',
          })
          session.emit(userMessage(`provider-${submissionId}`, 'Repeat this.', turnId))
        }
        session.emit({ type: 'turn.completed', turnId, status: 'completed' })
      }
      const users = store
        .history(thread.id)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'item.completed' }> =>
            event.type === 'item.completed' &&
            event.item.type === 'message' &&
            event.item.role === 'user',
        )
      expect(users.map(({ item }) => [item.id, item.text])).toEqual([
        ['submission-a', 'Repeat this.'],
        ['submission-b', 'Repeat this.'],
      ])
      expect(store.history(thread.id).some(({ event }) => event.type === 'item.delta')).toBe(false)
    } finally {
      await orchestrator.disposeAll()
    }
  })
  it('persists the exact user item before an accepted request returns', async () => {
    const { orchestrator, sessions, store } = harness()
    let release = () => {}
    let submitting = Promise.resolve<unknown>(undefined)
    try {
      const thread = await orchestrator.startThread('api', '/repo')
      const session = sessions[0]!
      session.turnIds.push('turn-in-flight')
      session.eventDuringSend = turnStarted(thread.id, 'turn-in-flight')
      session.afterEventBarrier = new Promise<void>((resolve) => (release = resolve))
      submitting = orchestrator.submitTurn(thread.id, 'Accepted.', [], {}, 'submission-in-flight')
      await vi.waitFor(() => expect(store.hasItem(thread.id, 'submission-in-flight')).toBe(true))
      expect(store.history(thread.id).map(({ event }) => event.type)).toEqual([
        'turn.started',
        'item.completed',
      ])
    } finally {
      release()
      await submitting.catch(() => undefined)
      await orchestrator.disposeAll()
    }
  })
  it('preserves submission identity through queue drain and steer', async () => {
    const { orchestrator, sessions, store } = harness()
    let releaseSteer = () => {}
    let steering: Promise<void> | undefined
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds.push('turn-current', 'turn-queued', 'turn-steered')
      await orchestrator.submitTurn(thread.id, 'Repeat this.', [], {}, 'submission-current')
      session.emit(turnStarted(thread.id, 'turn-current'))
      const queued = await orchestrator.submitTurn(
        thread.id,
        'Repeat this.',
        [],
        {},
        'submission-queued',
      )
      const steered = await orchestrator.submitTurn(
        thread.id,
        'Repeat this.',
        [],
        {},
        'submission-steered',
      )
      if (!queued.queued || !steered.queued) throw new Error('expected queued submissions')
      session.steerBarriers.push(new Promise<void>((resolve) => (releaseSteer = resolve)))
      steering = orchestrator.steerQueuedTurn(thread.id, steered.queuedTurn.id)
      await vi.waitFor(() => expect(orchestrator.queue(thread.id).items).toHaveLength(1))
      await expect(
        orchestrator.submitTurn(thread.id, 'Repeat this.', [], {}, 'submission-steered'),
      ).rejects.toThrow(/clientSubmissionId.*already used/)
      await expect(orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)).rejects.toThrow(
        /already being steered/,
      )
      session.emit({ type: 'turn.completed', turnId: 'turn-current', status: 'completed' })
      expect(session.sent).toEqual(['Repeat this.'])
      releaseSteer()
      await steering
      await vi.waitFor(() => expect(session.sent).toEqual(['Repeat this.', 'Repeat this.']))
      session.emit(turnStarted(thread.id, 'turn-queued'))
      session.emit({ type: 'turn.completed', turnId: 'turn-queued', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toHaveLength(3))
      session.emit(turnStarted(thread.id, 'turn-steered'))
      const users = store
        .history(thread.id)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'item.completed' }> =>
            event.type === 'item.completed' && event.item.role === 'user',
        )
      expect(users.map(({ item }) => [item.id, item.turnId])).toEqual([
        ['submission-current', 'turn-current'],
        ['submission-queued', 'turn-queued'],
        ['submission-steered', 'turn-steered'],
      ])
    } finally {
      releaseSteer()
      await steering?.catch(() => undefined)
      await orchestrator.disposeAll()
    }
  })
  it('releases rejected identities but rejects a durable reuse', async () => {
    const { orchestrator, sessions } = harness()
    try {
      const thread = await orchestrator.startThread('api', '/repo')
      const session = sessions[0]!
      session.sendError = new Error('provider rejected')
      await expect(
        orchestrator.submitTurn(thread.id, 'Try this.', [], {}, 'submission-retry'),
      ).rejects.toThrow('provider rejected')
      session.sendError = undefined
      session.turnIds.push('turn-retry')
      await orchestrator.submitTurn(thread.id, 'Try this.', [], {}, 'submission-retry')
      session.emit(turnStarted(thread.id, 'turn-retry'))
      session.emit({ type: 'turn.completed', turnId: 'turn-retry', status: 'completed' })
      await expect(
        orchestrator.submitTurn(thread.id, 'Try this.', [], {}, 'submission-retry'),
      ).rejects.toThrow(/clientSubmissionId.*already used/)
    } finally {
      await orchestrator.disposeAll()
    }
  })
})

describe('provider-neutral design briefing', () => {
  it.each(ProviderIdSchema.options)(
    'runs the same adaptive question loop with %s',
    async (provider) => {
      const model = 'future-provider/model-that-needs-no-design-code'
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-flow-'))
      const { orchestrator, sessions, received, store, capturePreview } = harness()
      try {
        const thread = await orchestrator.startThread(provider, workspace, {})
        await orchestrator.sendTurn(thread.id, 'Create a website.', [DESIGN_BRIEF_ATTACHMENT], {
          model,
          effort: 'xhigh',
        })

        expect(sessions[0]?.sent[0]).toContain('Personal Harness Design Briefing mode')
        sessions[0]?.emit(
          message(
            JSON.stringify({
              status: 'questions',
              message: 'Preparing questions.',
              questions: Array.from({ length: 5 }, (_, index) => ({
                id: `field_${index}`,
                header: `Field ${index + 1}`,
                question: `What should field ${index + 1} be?`,
                allowOther: true,
                options: [{ label: 'Decide for me', description: 'Let the Design Agent decide.' }],
              })),
              brief: null,
            }),
            's1-turn',
          ),
        )

        const firstRequest = received.find(
          ({ event }) => event.type === 'user_input.requested',
        )?.event
        expect(firstRequest?.type).toBe('user_input.requested')
        if (firstRequest?.type !== 'user_input.requested') throw new Error('missing questions')
        expect(firstRequest.request.questions).toHaveLength(5)
        expect(store.designRun(thread.id)).toMatchObject({ phase: 'brief', askedQuestions: true })

        orchestrator.respondToUserInput(thread.id, firstRequest.request.id, {
          field_0: ['Something vague'],
        })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(2))
        expect(sessions[0]?.sent[1]).toContain('Something vague')

        sessions[0]?.emit(
          message(
            JSON.stringify({
              status: 'questions',
              message: 'Preparing questions.',
              questions: [
                {
                  id: 'field_0_clarification',
                  header: 'Clarify',
                  question: 'Could you clarify that answer?',
                  allowOther: true,
                  options: [
                    { label: 'Decide for me', description: 'Let the Design Agent decide.' },
                  ],
                },
              ],
              brief: null,
            }),
            's1-turn',
          ),
        )
        const followUp = received
          .filter(({ event }) => event.type === 'user_input.requested')
          .at(-1)?.event
        if (followUp?.type !== 'user_input.requested') throw new Error('missing follow-up')
        orchestrator.respondToUserInput(thread.id, followUp.request.id, {
          field_0_clarification: ['Decide for me'],
        })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(3))

        sessions[0]?.emit(
          message(
            JSON.stringify({
              status: 'complete',
              message: 'Brief complete.',
              questions: [],
              brief: {
                originalRequest: 'Create a website.',
                subject: 'Independent studio',
                pageType: 'Marketing site',
                scope: 'Single responsive page',
                primaryGoal: 'Generate enquiries',
                audience: 'Prospective clients',
                offer: 'Design services',
                primaryAction: 'Start a project',
                requiredContent: ['Selected work'],
                constraints: [],
                brandInputs: [],
                creativeControl: 'Agent-led',
                explicitAnswers: [{ question: 'Malformed', answer: ['Not a string'] }],
                assumptions: ['The agent chose unresolved details.'],
                unresolved: [],
              },
            }),
            's1-turn',
          ),
        )
        const finalRequest = received
          .filter(({ event }) => event.type === 'user_input.requested')
          .at(-1)?.event
        if (finalRequest?.type !== 'user_input.requested') throw new Error('missing final question')
        expect(finalRequest.request.questions).toHaveLength(1)
        expect(finalRequest.request.questions[0]?.id).toBe('final_note')

        orchestrator.respondToUserInput(thread.id, finalRequest.request.id, {
          final_note: ["No, that's everything"],
        })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(4))
        expect(store.designRun(thread.id)).toMatchObject({ phase: 'brand' })
        const brief = JSON.parse(readFileSync(path.join(workspace, '.taste', 'brief.json'), 'utf8'))
        expect(brief.subject).toBe('Independent studio')
        expect(brief.explicitAnswers).toEqual([
          { question: 'What should field 1 be?', answer: 'Something vague' },
          { question: 'Could you clarify that answer?', answer: 'Decide for me' },
        ])
        expect(sessions[0]?.userInputs).toEqual([])
        expect(sessions[0]?.sent[3]).toContain('Brand phase')

        // The transcript walks the user through the briefing in plain words:
        // an invitation, an ack per answer round, a clarify nudge, a close.
        const notes = received
          .filter(
            ({ event }) =>
              event.type === 'item.completed' &&
              event.item.type === 'message' &&
              event.item.id.startsWith('design-note-'),
          )
          .map(({ event }) =>
            event.type === 'item.completed' && event.item.type === 'message'
              ? event.item.text
              : undefined,
          )
        expect(notes).toEqual([
          'I have a few questions before designing — they are right below.',
          'Got it, thanks.',
          'Some answers need one more pass — please take another look below.',
          'Got it, thanks.',
          'Brief locked in. Starting the design.',
        ])

        sessions[0]?.emit(
          message(
            JSON.stringify({
              version: 1,
              creativeDirection: {
                summary: 'Warm editorial confidence',
                keywords: ['warm', 'precise'],
                avoid: ['generic gradients'],
              },
              colorPalette: [{ name: 'Ink', value: '#171717', usage: 'Primary text' }],
              typefaces: [
                { family: 'Inter', source: 'project', roles: ['body'], weights: [400, 600] },
              ],
              interfaceDirection: 'Editorial grid with tactile controls.',
              imageDirection: {
                summary: 'Human work in context',
                subjects: ['studio process'],
                treatment: 'Natural light',
                avoid: ['stock poses'],
              },
              motionDirection: {
                summary: 'Fast physical feedback',
                principles: ['interruptible transitions'],
                avoid: ['decorative looping'],
              },
              voice: { summary: 'Direct and assured', avoid: ['empty superlatives'] },
            }),
            's1-turn',
          ),
        )
        sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(5))
        expect(store.designRun(thread.id)).toMatchObject({ phase: 'page' })
        expect(sessions[0]?.sent[4]).toContain('Page Blueprint phase')

        sessions[0]?.emit(
          message(
            JSON.stringify({
              version: 1,
              page: { title: 'Studio', route: '/', description: 'Studio services' },
              navigation: [{ label: 'Work', target: '#work' }],
              sections: [
                {
                  id: 'hero',
                  purpose: 'Introduce the offer',
                  copy: {
                    heading: 'Design that earns attention',
                    body: ['A focused independent studio.'],
                    callsToAction: [{ label: 'Start a project', target: '#contact' }],
                  },
                  layout: 'Split editorial hero',
                  componentNeeds: [],
                  assetNeeds: [],
                },
              ],
              responsive: ['Stack the hero on narrow screens'],
              interactions: ['Anchor navigation'],
              acceptanceCriteria: ['Primary action is visible'],
            }),
            's1-turn',
          ),
        )
        sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(6))
        expect(sessions[0]?.sent[5]).toContain('Asset phase')

        sessions[0]?.emit(message(JSON.stringify({ version: 1, assets: [] }), 's1-turn'))
        sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(7))
        expect(sessions[0]?.sent[6]).toContain('Build phase')

        sessions[0]?.emit(
          message(
            JSON.stringify({
              status: 'complete',
              summary: 'Implemented the studio page.',
              files: ['src/page.tsx'],
              checks: ['pnpm typecheck — passed'],
            }),
            's1-turn',
          ),
        )
        sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(8))
        expect(sessions[0]?.sent[7]).toContain('Preview Setup phase')
        sessions[0]?.emit(
          message(
            JSON.stringify({
              version: 1,
              command: 'pnpm',
              args: ['dev', '--host', '127.0.0.1'],
              cwd: '.',
              url: 'http://127.0.0.1:5173',
              viewports: [
                { name: 'desktop', width: 1440, height: 1000 },
                { name: 'mobile', width: 390, height: 844 },
              ],
            }),
            's1-turn',
          ),
        )
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(9))
        expect(sessions[0]?.sent[8]).toContain('visual Review phase')
        expect(sessions[0]?.sentAttachments[8]).toHaveLength(2)
        sessions[0]?.emit(
          message(
            JSON.stringify({
              version: 1,
              verdict: 'repair',
              summary: 'One mobile issue remains.',
              findings: [
                {
                  id: 'hero_mobile_clip',
                  severity: 'major',
                  area: 'Hero at 390px',
                  evidence: 'The primary action is clipped.',
                  repair: 'Stack the hero content before the image.',
                },
              ],
            }),
            's1-turn',
          ),
        )
        sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(10))
        expect(sessions[0]?.sent[9]).toContain('repair attempt 1 of 2')
        sessions[0]?.emit(
          message(
            JSON.stringify({
              status: 'complete',
              summary: 'Fixed the mobile hero.',
              files: ['src/page.tsx'],
              checks: ['pnpm typecheck — passed'],
            }),
            's1-turn',
          ),
        )
        sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
        await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(11))
        sessions[0]?.emit(
          message(
            JSON.stringify({
              version: 1,
              verdict: 'pass',
              summary: 'The page now matches the approved direction.',
              findings: [],
            }),
            's1-turn',
          ),
        )
        sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
        await vi.waitFor(() =>
          expect(
            received.some(
              ({ event }) =>
                event.type === 'item.completed' &&
                event.item.text ===
                  'Website built. Preview ready at http://127.0.0.1:5173/. Visual review passed after 1 repair attempt.',
            ),
          ).toBe(true),
        )
        // Qualification and briefing run fast; every phase after the
        // validated brief keeps the user's requested effort.
        expect(sessions[0]?.sentOptions).toEqual([
          ...Array.from({ length: 3 }, () => ({ model, effort: 'low' })),
          ...Array.from({ length: 8 }, () => ({ model, effort: 'xhigh' })),
        ])
        expect(readdirSync(path.join(workspace, '.taste')).sort()).toEqual([
          'assets.json',
          'brand.json',
          'brief.json',
          'page.json',
          'review.json',
        ])
        expect(store.designRun(thread.id)).toBeUndefined()
        // The preview is a real dev server with its cwd in the session's
        // worktree. Left running it holds a port and, on Windows, a lock that
        // makes removing that worktree fail.
        expect(previewStops.count).toBeGreaterThan(0)
        expect(capturePreview).toHaveBeenCalledTimes(2)
        expect(
          JSON.parse(readFileSync(path.join(workspace, '.taste', 'review.json'), 'utf8')),
        ).toMatchObject({ verdict: 'pass', findings: [] })
        expect(
          received
            .filter(
              ({ event }) =>
                event.type === 'item.started' && event.item.text?.startsWith('design:'),
            )
            .map(({ event }) => (event.type === 'item.started' ? event.item.text : undefined)),
        ).toEqual([
          'design:brief',
          'design:brief',
          'design:brief',
          'design:brand',
          'design:page',
          'design:assets',
          'design:build',
          'design:preview',
          'design:review',
          'design:repair',
          'design:review',
        ])
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('clears a failed provider run so later prompts are not trapped behind it', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-error-'))
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', workspace)
      await orchestrator.sendTurn(thread.id, 'Build a site.', [DESIGN_BRIEF_ATTACHMENT])
      sessions[0]?.emit({ type: 'thread.error', threadId: thread.id, message: 'provider failed' })

      expect(store.designRun(thread.id)).toBeUndefined()
      await expect(orchestrator.submitTurn(thread.id, 'Continue normally.')).resolves.toMatchObject(
        {
          queued: false,
        },
      )
      expect(sessions[0]?.sent.at(-1)).toBe('Continue normally.')
    } finally {
      await orchestrator.disposeAll()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('recovers from one malformed phase response', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-correction-'))
    const { orchestrator, sessions, received, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', workspace)
      await orchestrator.sendTurn(thread.id, 'Build a site.', [DESIGN_BRIEF_ATTACHMENT])
      sessions[0]?.emit(message('not json', 's1-turn'))
      sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

      await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(2))
      expect(sessions[0]?.sent[1]).toContain('failed validation')
      sessions[0]?.emit(
        message(
          JSON.stringify({
            status: 'questions',
            message: 'Preparing questions.',
            questions: [
              {
                id: 'subject',
                header: 'Subject',
                question: 'What should the site present?',
                allowOther: true,
                options: [{ label: 'Decide for me', description: 'Choose a suitable subject.' }],
              },
            ],
            brief: null,
          }),
          's1-turn',
        ),
      )

      await vi.waitFor(() =>
        expect(received.some(({ event }) => event.type === 'user_input.requested')).toBe(true),
      )
      expect(store.designRun(thread.id)).toMatchObject({ phase: 'brief', correcting: false })
    } finally {
      await orchestrator.disposeAll()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('accepts final structured output after provider commentary', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-commentary-'))
    const { orchestrator, sessions, received, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', workspace)
      await orchestrator.sendTurn(thread.id, 'Build a site.', [DESIGN_BRIEF_ATTACHMENT])
      sessions[0]?.emit(message('I will inspect the project first.', 's1-turn'))
      sessions[0]?.emit(
        message(
          JSON.stringify({
            status: 'questions',
            message: 'Preparing questions.',
            questions: [
              {
                id: 'subject',
                header: 'Subject',
                question: 'What should the site present?',
                allowOther: true,
                options: [{ label: 'Decide for me', description: 'Choose a suitable subject.' }],
              },
            ],
            brief: null,
          }),
          's1-turn',
        ),
      )
      sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

      expect(received.some(({ event }) => event.type === 'user_input.requested')).toBe(true)
      expect(store.designRun(thread.id)).toMatchObject({ phase: 'brief', correcting: false })
      expect(sessions[0]?.sent).toHaveLength(1)
    } finally {
      await orchestrator.disposeAll()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('stops after a second malformed response', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-correction-'))
    const { orchestrator, sessions, received, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', workspace)
      await orchestrator.sendTurn(thread.id, 'Build a site.', [DESIGN_BRIEF_ATTACHMENT])
      sessions[0]?.emit(message('not json', 's1-turn'))
      sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
      await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(2))
      sessions[0]?.emit(message('still not json', 's1-turn'))
      sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

      expect(store.designRun(thread.id)).toBeUndefined()
      expect(
        received.some(
          ({ event }) =>
            event.type === 'thread.error' && event.message.includes('Design mode failed'),
        ),
      ).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('stops the workflow when its provider turn is interrupted', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-interrupt-'))
    const { orchestrator, sessions, received, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', workspace)
      await orchestrator.sendTurn(thread.id, 'Build a site.', [DESIGN_BRIEF_ATTACHMENT])
      sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'interrupted' })

      expect(store.designRun(thread.id)).toBeUndefined()
      expect(sessions[0]?.sent).toHaveLength(1)
      expect(
        received.some(
          ({ event }) =>
            event.type === 'item.completed' &&
            event.item.text === 'design:brief' &&
            event.item.status === 'failed',
        ),
      ).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })
})

describe('persisted threads', () => {
  it('restores an unanswered design briefing question', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-question-resume-'))
    const store = new Store(':memory:')
    store.addProject(workspace)
    store.addThread({
      id: 'persisted-question',
      projectPath: workspace,
      provider: 'codex',
      title: 'Persisted question',
    })
    store.setDesignRun('persisted-question', {
      originalRequest: 'Build a site.',
      options: {},
      phase: 'brief',
      askedQuestions: true,
      finalAsked: false,
      explicitAnswers: [],
    })
    store.append('persisted-question', {
      type: 'user_input.requested',
      request: {
        id: 'persisted-input',
        turnId: 'brief-turn',
        questions: [
          {
            id: 'audience',
            header: 'Audience',
            question: 'Who is this for?',
            allowOther: true,
            secret: false,
            options: [{ label: 'Decide for me', description: 'Choose the audience.' }],
          },
        ],
        autoResolutionMs: null,
        createdAt: 1,
      },
    })
    const { orchestrator, sessions } = harness(undefined, store)
    try {
      await orchestrator.submitTurn('persisted-question', 'Queue this.')
      expect(sessions[0]?.sent).toEqual([])

      orchestrator.respondToUserInput('persisted-question', 'persisted-input', {
        audience: ['Independent founders'],
      })
      await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(1))
      expect(sessions[0]?.sent[0]).toContain('Independent founders')
    } finally {
      await orchestrator.disposeAll()
      store.close()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('resumes a persisted design phase before accepting a new prompt', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-resume-'))
    const store = new Store(':memory:')
    store.addProject(workspace)
    store.addThread({
      id: 'persisted-design',
      projectPath: workspace,
      provider: 'codex',
      title: 'Persisted design',
    })
    writeDesignBrief(workspace, {
      originalRequest: 'Build a studio site.',
      subject: 'Studio',
      pageType: 'Marketing site',
      scope: 'Single page',
      primaryGoal: 'Generate enquiries',
      audience: 'Prospective clients',
      offer: 'Design services',
      primaryAction: 'Start a project',
      requiredContent: [],
      constraints: [],
      brandInputs: [],
      creativeControl: 'Agent-led',
      explicitAnswers: [],
      assumptions: [],
      unresolved: [],
    })
    store.setDesignRun('persisted-design', {
      workspacePath: 'ignored-stale-path',
      originalRequest: 'Build a studio site.',
      options: { model: 'shared-model', effort: 'high' },
      phase: 'brand',
      askedQuestions: false,
      finalAsked: false,
      explicitAnswers: [],
    })
    const { orchestrator, sessions } = harness(undefined, store)
    try {
      await expect(
        orchestrator.submitTurn('persisted-design', 'Do this after design.'),
      ).resolves.toMatchObject({ queued: true })
      await vi.waitFor(() => expect(sessions[0]?.sent).toHaveLength(1))
      expect(sessions[0]?.sent[0]).toContain('Brand phase')
      // Recovery keeps the user's effort for post-brief phases instead of the
      // lowered briefing setting.
      expect(sessions[0]?.sentOptions[0]).toEqual({ model: 'shared-model', effort: 'high' })
      expect(orchestrator.queue('persisted-design').items[0]?.text).toBe('Do this after design.')
    } finally {
      await orchestrator.disposeAll()
      store.close()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('resumes a stored Codex thread once and preserves concurrent prompt order', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
      worktreePath: '/worktrees/persisted',
      worktreeBranch: 'harness/persisted',
    })
    const { orchestrator, sessions, resumedIds, resumedIn } = harness(undefined, store)

    expect(orchestrator.queue('persisted-thread')).toEqual({ items: [], canSteer: false })
    const first = orchestrator.submitTurn('persisted-thread', 'first')
    const second = orchestrator.submitTurn('persisted-thread', 'second')

    await expect(first).resolves.toMatchObject({ queued: false })
    await expect(second).resolves.toMatchObject({ queued: true })
    expect(resumedIds).toEqual(['persisted-thread'])
    expect(resumedIn).toEqual(['/worktrees/persisted'])
    expect(sessions[0]?.sent).toEqual(['first'])
    expect(orchestrator.queue('persisted-thread').items.map((item) => item.text)).toEqual([
      'second',
    ])

    sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await vi.waitFor(() => expect(sessions[0]?.sent).toEqual(['first', 'second']))
  })

  it('restores the shared reply instructions when resuming a Codex thread', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    const { orchestrator, resumedOptions } = harness(undefined, store)

    await orchestrator.submitTurn('persisted-thread', 'continue')

    expect(resumedOptions[0]?.instructions).toContain('clear, capable teammate')
    expect(resumedOptions[0]?.instructions).toContain('Do not use em dashes')
  })

  it('does not invent continuity for a provider without resume support', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'claude-thread',
      projectPath: '/repo',
      provider: 'claude-code',
      title: 'Persisted Claude',
    })
    const { orchestrator } = harness(undefined, store)

    await expect(orchestrator.submitTurn('claude-thread', 'continue')).rejects.toThrow(
      'claude-code sessions cannot resume after Harness restarts yet',
    )
  })
})

describe('MCP inventory', () => {
  it('reports unsupported providers without starting one', async () => {
    const { orchestrator } = harness()

    await expect(orchestrator.listMcpServers('claude-code', '/repo')).resolves.toEqual({
      capabilities: {
        inventory: false,
        add: false,
        update: false,
        remove: false,
        reload: false,
        startOAuth: false,
        cancelOAuth: false,
      },
      servers: [],
    })
  })

  it('reads live startup state from the project session', async () => {
    const { orchestrator, sessions } = harness()
    await orchestrator.startThread('codex', '/repo')
    sessions[0]!.mcpServers = [
      {
        id: 'docs',
        scope: 'global',
        enabled: true,
        auth: { status: 'not_required' },
        startup: { state: 'failed', message: 'program not found' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ]

    await expect(orchestrator.listMcpServers('codex', '/repo')).resolves.toMatchObject({
      capabilities: { inventory: true },
      servers: [{ id: 'docs', startup: { state: 'failed' } }],
    })
  })

  it('applies project overrides and resolves only their credential references', async () => {
    const { orchestrator, startedOptions } = harness()
    orchestrator.addMcpServer('codex', '/repo', {
      id: 'docs',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: { source: 'credential', credentialRef: 'mcp/docs/auth' } },
      },
    })

    await orchestrator.startThread('codex', '/repo')

    expect(startedOptions[0]).toMatchObject({
      mcpServers: [{ id: 'docs', enabled: true }],
      mcpCredentials: { 'mcp/docs/auth': 'secret:mcp/docs/auth' },
    })
    await expect(orchestrator.listMcpServers('codex', '/repo')).resolves.toMatchObject({
      capabilities: { add: true, reload: true, startOAuth: true, cancelOAuth: false },
      servers: [{ id: 'docs', scope: 'project', enabled: true }],
    })
  })
})

describe('skills inventory', () => {
  it('capability-gates unsupported providers', async () => {
    const { orchestrator } = harness()

    await expect(orchestrator.listSkills('claude-code', '/repo')).resolves.toEqual({
      capabilities: { inventory: false, configure: false, install: false },
      skills: [],
      errors: [],
    })
  })

  it('rejects installation for unsupported providers before touching the folder', async () => {
    const { orchestrator } = harness()

    await expect(
      orchestrator.installSkillFromFolder('claude-code', '/repo', '/selected-skill'),
    ).rejects.toThrow('provider "claude-code" cannot install skills yet')
  })
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

  it('interrupts every live session concurrently and reports adapter failures', async () => {
    const { sessions, orchestrator } = harness()
    await orchestrator.startThread('codex', '/repo')
    await orchestrator.startThread('codex', '/repo')
    await orchestrator.startThread('codex', '/repo')

    let releaseFirst = () => {}
    sessions[0]!.interruptBarrier = new Promise<void>((resolve) => (releaseFirst = resolve))
    sessions[1]!.interruptError = new Error('adapter did not respond')

    const stopping = orchestrator.panicStop()
    await vi.waitFor(() =>
      expect(sessions.map((session) => session.interrupted)).toEqual([true, true, true]),
    )
    releaseFirst()

    await expect(stopping).resolves.toEqual({
      sessions: [
        { threadId: 'thread-1', status: 'interrupted' },
        { threadId: 'thread-2', status: 'failed', error: 'adapter did not respond' },
        { threadId: 'thread-3', status: 'interrupted' },
      ],
    })
  })

  it('drops queued prompts so interrupted sessions do not restart', async () => {
    const { sessions, orchestrator, store, queueChanges } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'running')
    await orchestrator.submitTurn(thread.id, 'do not restart')

    const beforePanic = queueChanges.length
    await orchestrator.panicStop()
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'interrupted' })

    await vi.waitFor(() => expect(orchestrator.queue(thread.id).items).toEqual([]))
    expect(store.queuedTurns(thread.id)).toEqual([])
    expect(sessions[0]!.sent).toEqual(['running'])
    expect(queueChanges.slice(beforePanic)).toEqual([{ threadId: thread.id, itemIds: [] }])
  })

  it.each(['store', 'listener'] as const)(
    'still interrupts and releases its latch after a %s queue failure',
    async (failure) => {
      const { sessions, orchestrator, store, queueNotificationError } = harness()
      const first = await orchestrator.startThread('codex', '/repo')
      await orchestrator.startThread('codex', '/repo')
      await orchestrator.submitTurn(first.id, 'Running.')
      await orchestrator.submitTurn(first.id, 'Do not run after failed Stop all.')
      if (failure === 'store') {
        vi.spyOn(store, 'clearAllQueuedTurns').mockImplementationOnce(() => {
          throw new Error('C:\\private\\harness.db is full')
        })
      } else {
        queueNotificationError.current = new Error('listener failed')
      }

      await expect(orchestrator.panicStop()).rejects.toThrow(
        'could not clear every queued prompt during Stop all',
      )
      expect(sessions.map(({ interrupted }) => interrupted)).toEqual([true, true])
      queueNotificationError.current = undefined
      sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'interrupted' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sessions[0]!.sent).toEqual(['Running.'])
      expect(orchestrator.queue(first.id).items).toEqual([])
      expect(store.queuedTurns(first.id)).toHaveLength(failure === 'store' ? 1 : 0)
      await expect(
        orchestrator.submitTurn(first.id, 'Work after failed Stop all.'),
      ).resolves.toMatchObject({ queued: false })
    },
  )

  it('drops durable queues that were never loaded into this process', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(thread.id, 'Queued.', [], {}, 'submission-old')
    await orchestrator.disposeAll()

    await expect(orchestrator.panicStop()).resolves.toEqual({ sessions: [] })
    expect(store.queuedTurns(thread.id)).toEqual([])
    await orchestrator.submitTurn(thread.id, 'New work.', [], {}, 'submission-new')
    expect(sessions[1]?.sent).toEqual(['New work.'])
  })

  it('cancels a turn still waiting for its checkpoint', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    let release = (_value: checkpoint.Snapshot) => {}
    vi.spyOn(checkpoint, 'takeSnapshot').mockReturnValueOnce(
      new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)),
    )

    const sending = orchestrator.submitTurn(thread.id, 'not after panic')
    await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(true))
    await orchestrator.panicStop()
    release({ commit: 'checkpoint', clean: true })

    await expect(sending).rejects.toThrow('turn cancelled by panic stop')
    expect(sessions[0]!.sent).toEqual([])
  })

  it('force-stops an adapter that does not acknowledge interruption', async () => {
    vi.useFakeTimers()
    try {
      const { sessions, orchestrator } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      sessions[0]!.interruptBarrier = new Promise(() => {})

      const stopping = orchestrator.panicStop()
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(stopping).resolves.toEqual({
        sessions: [
          {
            threadId: thread.id,
            status: 'failed',
            error: 'interrupt timed out; session was force-stopped',
          },
        ],
      })
      expect(sessions[0]!.disposed).toBe(true)
      expect(orchestrator.isRunning(thread.id)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sidebar inbox lifecycle', () => {
  it('supports every manual transition and rejects hidden active work', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')

    expect(orchestrator.settleThread(thread.id).state).toBe('settled')
    expect(() => orchestrator.unsnoozeThread(thread.id)).toThrow(/expected snoozed/)
    expect(orchestrator.unsettleThread(thread.id)).toMatchObject({ state: 'active' })
    expect(orchestrator.snoozeThread(thread.id, Date.now() + 60_000).state).toBe('snoozed')
    expect(orchestrator.unsnoozeThread(thread.id)).toMatchObject({ state: 'active' })
    expect(orchestrator.setThreadKeepActive(thread.id, true)).toMatchObject({
      state: 'active',
      keepActive: true,
    })

    await orchestrator.submitTurn(thread.id, 'working')
    expect(() => orchestrator.settleThread(thread.id)).toThrow(/status is working/)
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
    expect(orchestrator.inboxStatus(thread.id)).toBe('ready')
    expect(store.thread(thread.id)?.unread).toBe(true)

    sessions[0]!.emit({
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', command: 'pnpm test', createdAt: 1 },
    })
    expect(orchestrator.inboxStatus(thread.id)).toBe('approval')
    expect(() => orchestrator.snoozeThread(thread.id, Date.now() + 60_000)).toThrow(
      /status is approval/,
    )
  })

  it('automatically wakes activity and settles only eligible inactive work', async () => {
    const { orchestrator, sessions, store, lifecycles } = harness()
    const wakes = await orchestrator.startThread('codex', '/repo')
    const settles = await orchestrator.startThread('codex', '/repo')
    const kept = await orchestrator.startThread('codex', '/repo')
    const now = Date.now()

    orchestrator.snoozeThread(wakes.id, now + 1_000)
    orchestrator.setThreadKeepActive(kept.id, true)
    orchestrator.refreshLifecycle(now + 4 * 24 * 60 * 60 * 1_000)

    expect(store.thread(wakes.id)?.lifecycle).toMatchObject({ state: 'active' })
    expect(store.thread(settles.id)?.lifecycle).toMatchObject({
      state: 'settled',
      reason: 'inactivity',
    })
    expect(store.thread(kept.id)?.lifecycle).toMatchObject({ state: 'active', keepActive: true })

    orchestrator.settleThread(wakes.id)
    sessions[0]!.emit({
      type: 'turn.started',
      turn: { id: 'resumed', threadId: wakes.id, status: 'running', createdAt: now },
    })
    expect(store.thread(wakes.id)?.lifecycle).toMatchObject({ state: 'active' })
    expect(lifecycles.at(-1)).toMatchObject({
      threadId: wakes.id,
      lifecycle: { state: 'active' },
    })
  })

  it('keeps archived state separate and honors the Off setting', async () => {
    const { orchestrator, store } = harness()
    const archived = await orchestrator.startThread('codex', '/repo')
    const inactive = await orchestrator.startThread('codex', '/repo')
    orchestrator.close(archived.id)

    expect(() => orchestrator.settleThread(archived.id)).toThrow(/archived/)
    store.updateSidebarSettings({ autoSettleDays: null })
    orchestrator.refreshLifecycle(Date.now() + 100 * 24 * 60 * 60 * 1_000)
    expect(store.thread(inactive.id)?.lifecycle).toMatchObject({ state: 'active' })
    expect(store.thread(archived.id)?.closedAt).toBeDefined()
  })
})

describe('queued turns', () => {
  it('restores exact mutations and drains in order after a server restart', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-orchestrator-queue-'))
    const file = path.join(dir, 'harness.db')
    const seededStore = new Store(file)
    const seeded = harness(undefined, seededStore)
    try {
      const thread = await seeded.orchestrator.startThread('codex', '/repo')
      const submit = seeded.orchestrator.submitTurn.bind(seeded.orchestrator)
      await seeded.orchestrator.submitTurn(thread.id, 'Active.', [], {}, 'submission-active')
      seeded.sessions[0]!.emit(turnStarted(thread.id, 'active-turn'))
      for (const [id, attachment, model] of [
        ['submission-a', 'C:\\private\\a.png', 'model-a'],
        ['submission-b', 'C:\\private\\b.png', 'model-b'],
        ['submission-c', 'C:\\private\\c.png', 'model-c'],
      ] as const) {
        await submit(thread.id, 'Repeat.', [attachment], { model }, id)
      }
      seeded.orchestrator.moveQueuedTurn(thread.id, 'submission-c', 'up')
      seeded.orchestrator.deleteQueuedTurn(thread.id, 'submission-a')
      await seeded.orchestrator.disposeAll()
      seededStore.close()

      const restartedStore = new Store(file)
      restartedStore.recoverInterruptedThreads()
      const restarted = harness(undefined, restartedStore)
      try {
        expect(restarted.orchestrator.queue(thread.id).items.map(({ id }) => id)).toEqual([
          'submission-c',
          'submission-b',
        ])
        await restarted.orchestrator.submitTurn(thread.id, 'Wake the queue.')
        await vi.waitFor(() => expect(restarted.sessions[0]?.sent).toEqual(['Repeat.']))
        expect(restarted.sessions[0]?.sentAttachments[0]).toEqual(['C:\\private\\c.png'])
        expect(restarted.sessions[0]?.sentOptions[0]).toEqual({ model: 'model-c' })

        restarted.sessions[0]!.emit({ type: 'turn.completed', turnId: 't', status: 'completed' })
        await vi.waitFor(() => expect(restarted.sessions[0]?.sent).toHaveLength(2))
        expect(restarted.orchestrator.queue(thread.id).items).toHaveLength(1)
      } finally {
        await restarted.orchestrator.disposeAll()
        restartedStore.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores a provider-rejected drain without logging prompt content or paths', async () => {
    const { sessions, orchestrator, store, logs } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(
      thread.id,
      'private prompt content',
      ['C:\\secret\\private.png'],
      {},
      'submission-private',
    )
    sessions[0]!.sendError = new Error(
      'provider rejected private prompt content at C:\\secret\\private.png',
    )

    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

    await vi.waitFor(() => expect(logs).toContain('could not start queued turn; it remains queued'))
    expect(orchestrator.queue(thread.id).items.map(({ id }) => id)).toEqual(['submission-private'])
    expect(store.queuedTurns(thread.id).map(({ id }) => id)).toEqual(['submission-private'])
    expect(logs.join('\n')).not.toMatch(/private prompt content|secret\\private/)
  })

  it('does not resurrect work accepted before the provider request rejects', async () => {
    const { sessions, orchestrator, store, logs } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(thread.id, 'Accepted once.', [], {}, 'submission-accepted')
    sessions[0]!.eventDuringSend = turnStarted(thread.id, 'accepted-turn')
    sessions[0]!.afterEventBarrier = Promise.reject(new Error('request disconnected'))

    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

    await vi.waitFor(() =>
      expect(logs).toContain('queued turn ended after acceptance or cancellation'),
    )
    expect(store.queuedTurns(thread.id)).toEqual([])
    expect(store.hasItem(thread.id, 'submission-accepted')).toBe(true)
  })

  it('does not revive a closed thread after a legacy queued send resolves', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(thread.id, 'Legacy queued work.')
    sessions[0]!.release = () => {}
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await vi.waitFor(() => expect(sessions[0]!.sent).toHaveLength(2))

    orchestrator.close(thread.id)
    sessions[0]!.release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
    expect(orchestrator.queue(thread.id).items).toEqual([])
    expect(store.thread(thread.id)?.closedAt).toBeDefined()
  })

  it('does not touch the store when a queued send rejects after server disposal', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(thread.id, 'Queued work.')
    sessions[0]!.release = () => {}
    sessions[0]!.sendError = new Error('provider stopped')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await vi.waitFor(() => expect(sessions[0]!.sent).toHaveLength(2))

    await orchestrator.disposeAll()
    store.close()
    sessions[0]!.release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('does not restore or drain a steer that resolves after server disposal', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    sessions[0]!.emit(turnStarted(thread.id, 'active-turn'))
    const queued = await orchestrator.submitTurn(thread.id, 'Steer later.')
    if (!queued.queued) throw new Error('expected the prompt to queue')
    let release = () => {}
    sessions[0]!.steerBarriers.push(new Promise<void>((resolve) => (release = resolve)))
    const steering = orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)
    await vi.waitFor(() => expect(sessions[0]!.steered).toEqual(['Steer later.']))

    await orchestrator.disposeAll()
    store.close()
    release()

    await expect(steering).resolves.toBeUndefined()
  })

  it('runs queued prompts in order after the active turn completes', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')

    await expect(orchestrator.submitTurn(thread.id, 'first')).resolves.toMatchObject({
      queued: false,
    })
    await expect(orchestrator.submitTurn(thread.id, 'second')).resolves.toMatchObject({
      queued: true,
    })
    await expect(orchestrator.submitTurn(thread.id, 'third')).resolves.toMatchObject({
      queued: true,
    })
    expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual([
      'second',
      'third',
    ])

    sessions[0]!.emit({
      type: 'turn.completed',
      turnId: 'first-turn',
      status: 'completed',
    })
    await vi.waitFor(() => expect(sessions[0]!.sent).toEqual(['first', 'second']))
    expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['third'])

    sessions[0]!.emit({
      type: 'turn.completed',
      turnId: 'second-turn',
      status: 'completed',
    })
    await vi.waitFor(() => expect(sessions[0]!.sent).toEqual(['first', 'second', 'third']))
    expect(orchestrator.queue(thread.id).items).toEqual([])
  })

  it('can remove a queued prompt or steer it into the running turn', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'first')
    await orchestrator.submitTurn(thread.id, 'remove me')
    const steer = await orchestrator.submitTurn(thread.id, 'steer with this')
    if (!steer.queued) throw new Error('expected the prompt to queue')

    const remove = orchestrator.queue(thread.id).items[0]!
    orchestrator.deleteQueuedTurn(thread.id, remove.id)
    await orchestrator.steerQueuedTurn(thread.id, steer.queuedTurn.id)

    expect(sessions[0]!.steered).toEqual(['steer with this'])
    expect(orchestrator.queue(thread.id).items).toEqual([])
  })

  it('moves a queued prompt without changing its contents', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'running')
    await orchestrator.submitTurn(thread.id, 'first queued')
    const second = await orchestrator.submitTurn(thread.id, 'second queued', ['/reference.png'])
    if (!second.queued) throw new Error('expected the prompt to queue')

    orchestrator.moveQueuedTurn(thread.id, second.queuedTurn.id, 'up')

    expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual([
      'second queued',
      'first queued',
    ])
    expect(orchestrator.queue(thread.id).items[0]?.attachments).toEqual(['/reference.png'])
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

  it('refuses diff review in a shared project checkout', async () => {
    const { orchestrator } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo)

    await expect(orchestrator.diff(thread.id)).rejects.toThrow(/isolated session/)
  })

  it('does not reject work while the agent turn is running', async () => {
    const { store, orchestrator } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktree = store.thread(thread.id)!.worktreePath!
    writeFileSync(path.join(worktree, 'file.txt'), 'agent work\n')
    const diff = await orchestrator.diff(thread.id)
    const file = diff.files[0]!

    await orchestrator.submitTurn(thread.id, 'keep working')

    await expect(
      orchestrator.reviewHunk(thread.id, diff.version, file.path, file.hunks[0]!.id, 'reject'),
    ).rejects.toThrow(/turn is running/)
    expect(readFileSync(path.join(worktree, 'file.txt'), 'utf8')).toBe('agent work\n')
  })

  it('refuses to discard a checkout holding work nobody has committed', async () => {
    const { store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    writeFileSync(path.join(store.thread(thread.id)!.worktreePath!, 'file.txt'), 'agent work\n')

    await expect(orchestrator.discardWorktree(thread.id)).rejects.toThrow(/uncommitted/i)
    // Refusing has to actually leave it there.
    expect(existsSync(store.thread(thread.id)!.worktreePath!)).toBe(true)
  })

  it('waits for the checkout terminal to exit before discarding its worktree', async () => {
    const { store, orchestrator } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktreePath = store.thread(thread.id)!.worktreePath!

    orchestrator.openTerminal(thread.id, 80, 24)
    await orchestrator.discardWorktree(thread.id)

    expect(existsSync(worktreePath)).toBe(false)
  }, 20_000)

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

describe('rolling a session back', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'harness-cp-orch-'))
    execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true })
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'core.autocrlf', 'false')
    writeFileSync(path.join(repo, 'file.txt'), 'original\n')
    git('add', '.')
    git('commit', '-m', 'first')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('takes a checkpoint before the agent writes, not after', async () => {
    const { orchestrator } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'change the file')

    // A checkpoint taken afterwards would record the damage rather than the
    // state worth returning to.
    const checkpoints = orchestrator.checkpoints(thread.id)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]?.label).toBe('change the file')
  })

  it('puts the files back and drops the conversation that described them', async () => {
    const { sessions, store, orchestrator } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    sessions[0]!.emit(message('did the first thing'))

    await orchestrator.sendTurn(thread.id, 'second task')
    writeFileSync(path.join(repo, 'file.txt'), 'the agent went the wrong way\n')
    sessions[0]!.emit(message('did the wrong thing'))

    const second = orchestrator.checkpoints(thread.id)[1]!
    await orchestrator.restoreCheckpoint(thread.id, second.id)

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    // Leaving the transcript would have it describing work that is gone.
    const texts = store
      .history(thread.id)
      .map((e) => (e.event.type === 'item.completed' ? e.event.item.text : undefined))
      .filter(Boolean)
    expect(texts).toEqual(['did the first thing'])
  })

  it('restores files and conversation when a restore is undone', async () => {
    const { orchestrator, sessions, store } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'a task')
    writeFileSync(path.join(repo, 'file.txt'), 'work the user might want\n')
    sessions[0]!.emit(message('work the user might want'))

    const first = orchestrator.checkpoints(thread.id)[0]!
    const { undo } = await orchestrator.restoreCheckpoint(thread.id, first.id)

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    expect(store.history(thread.id)).toEqual([])

    await orchestrator.undoRestore(thread.id, undo)

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('work the user might want\n')
    expect(text(store.history(thread.id))).toEqual(['work the user might want'])
    await expect(orchestrator.undoRestore(thread.id, undo)).rejects.toThrow(
      'restore can no longer be undone',
    )
  })

  it('names what changed since a checkpoint', async () => {
    const { orchestrator } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'a task')
    writeFileSync(path.join(repo, 'file.txt'), 'changed\n')
    writeFileSync(path.join(repo, 'new.txt'), 'added\n')

    const first = orchestrator.checkpoints(thread.id)[0]!
    const files = await orchestrator.changedSinceCheckpoint(thread.id, first.id)
    expect(files.sort()).toEqual(['file.txt', 'new.txt'])
  })

  it('rejects inspection of a missing checkpoint', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)

    await expect(orchestrator.changedSinceCheckpoint(thread.id, 404)).rejects.toThrow(
      'no such checkpoint',
    )
  })

  it('refuses to restore while the agent is still writing', async () => {
    const { orchestrator, sessions } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'a task')
    sessions[0]!.emit({
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: thread.id, status: 'running', createdAt: 0 },
    })

    const checkpoint = orchestrator.checkpoints(thread.id)[0]!
    await expect(orchestrator.restoreCheckpoint(thread.id, checkpoint.id)).rejects.toThrow(
      'cannot restore during a running turn',
    )
  })

  it('refuses to restore while a turn is still taking its checkpoint', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    const first = orchestrator.checkpoints(thread.id)[0]!

    let release = (_value: checkpoint.Snapshot) => {}
    vi.spyOn(checkpoint, 'takeSnapshot').mockReturnValueOnce(
      new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)),
    )
    const sending = orchestrator.sendTurn(thread.id, 'second task')
    await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(true))

    try {
      await expect(orchestrator.restoreCheckpoint(thread.id, first.id)).rejects.toThrow(
        'cannot restore during a running turn',
      )
    } finally {
      release({ commit: 'checkpoint', clean: true })
      await sending
    }
  })

  it('refuses to undo a restore while a turn is still taking its checkpoint', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    writeFileSync(path.join(repo, 'file.txt'), 'work to restore later\n')
    const first = orchestrator.checkpoints(thread.id)[0]!
    const { undo } = await orchestrator.restoreCheckpoint(thread.id, first.id)

    let release = (_value: checkpoint.Snapshot) => {}
    vi.spyOn(checkpoint, 'takeSnapshot').mockReturnValueOnce(
      new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)),
    )
    const sending = orchestrator.sendTurn(thread.id, 'second task')
    await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(true))

    try {
      await expect(orchestrator.undoRestore(thread.id, undo)).rejects.toThrow(
        'cannot restore during a running turn',
      )
    } finally {
      release({ commit: 'checkpoint', clean: true })
      await sending
    }
  })

  it('refuses restore and undo while an automatic design turn is still starting', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    writeFileSync(path.join(repo, 'file.txt'), 'work to restore later\n')
    const first = orchestrator.checkpoints(thread.id)[0]!
    const { undo } = await orchestrator.restoreCheckpoint(thread.id, first.id)

    await orchestrator.sendTurn(thread.id, 'Build a site.', [DESIGN_BRIEF_ATTACHMENT])
    const designCheckpoint = orchestrator.checkpoints(thread.id).at(-1)!
    const session = sessions[0]!
    session.release = () => {}
    session.emit(message('not json', 's1-turn'))
    session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await vi.waitFor(() => expect(session.sent.at(-1)).toContain('failed validation'))

    try {
      expect(orchestrator.isTurnRunning(thread.id)).toBe(true)
      await expect(orchestrator.restoreCheckpoint(thread.id, designCheckpoint.id)).rejects.toThrow(
        'cannot restore during a running turn',
      )
      await expect(orchestrator.undoRestore(thread.id, undo)).rejects.toThrow(
        'cannot restore during a running turn',
      )

      orchestrator.close(thread.id)
      expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
    } finally {
      session.release?.()
      await orchestrator.disposeAll()
    }
  })

  it('refuses a second restore while the first restore is still in progress', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    const first = orchestrator.checkpoints(thread.id)[0]!

    let release = (_value: checkpoint.Snapshot) => {}
    const restoringSnapshot = new Promise<checkpoint.Snapshot>((resolve) => (release = resolve))
    const restoreSnapshot = vi
      .spyOn(checkpoint, 'restoreSnapshot')
      .mockClear()
      .mockReturnValueOnce(restoringSnapshot)
    const restoring = orchestrator.restoreCheckpoint(thread.id, first.id)
    await vi.waitFor(() => expect(restoreSnapshot).toHaveBeenCalledTimes(1))

    const history = Promise.resolve(orchestrator.history(thread.id))
    let historySettled = false
    void history.then(() => (historySettled = true))
    try {
      await new Promise((resolve) => setImmediate(resolve))
      expect(historySettled).toBe(false)
      await expect(orchestrator.restoreCheckpoint(thread.id, first.id)).rejects.toThrow(
        'cannot restore while another restore is running',
      )
    } finally {
      release({ commit: 'replaced', clean: false })
      await restoring
    }
    expect(await history).toEqual([])
  })

  it('refuses a new turn while a checkpoint restore is still in progress', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    const first = orchestrator.checkpoints(thread.id)[0]!

    let release = (_value: checkpoint.Snapshot) => {}
    const restoringSnapshot = new Promise<checkpoint.Snapshot>((resolve) => (release = resolve))
    const restoreSnapshot = vi
      .spyOn(checkpoint, 'restoreSnapshot')
      .mockClear()
      .mockReturnValueOnce(restoringSnapshot)
    const restoring = orchestrator.restoreCheckpoint(thread.id, first.id)
    await vi.waitFor(() => expect(restoreSnapshot).toHaveBeenCalledTimes(1))

    try {
      await expect(orchestrator.sendTurn(thread.id, 'too soon')).rejects.toThrow(
        'cannot start a turn while restoring a checkpoint',
      )
      expect(sessions[0]!.sent).toEqual(['first task'])
    } finally {
      release({ commit: 'replaced', clean: false })
      await restoring
    }
  })

  it('refuses restore and undo while a diff rejection is still in progress', async () => {
    const trees = path.join(path.dirname(repo), 'trees')
    const { orchestrator, store } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktree = store.thread(thread.id)!.worktreePath!
    await orchestrator.sendTurn(thread.id, 'first task')
    writeFileSync(path.join(worktree, 'file.txt'), 'work to restore later\n')
    const first = orchestrator.checkpoints(thread.id)[0]!
    const { undo } = await orchestrator.restoreCheckpoint(thread.id, first.id)

    writeFileSync(path.join(worktree, 'file.txt'), 'reject this change\n')
    const diff = await orchestrator.diff(thread.id)
    const file = diff.files[0]!
    const heldSnapshot = await checkpoint.takeSnapshot(worktree)
    let release = (_value: checkpoint.Snapshot) => {}
    const takeSnapshot = vi
      .spyOn(checkpoint, 'takeSnapshot')
      .mockClear()
      .mockReturnValueOnce(new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)))
    const reviewing = orchestrator.reviewHunk(
      thread.id,
      diff.version,
      file.path,
      file.hunks[0]!.id,
      'reject',
    )
    await vi.waitFor(() => expect(takeSnapshot).toHaveBeenCalledTimes(1))

    try {
      await expect(orchestrator.restoreCheckpoint(thread.id, first.id)).rejects.toThrow(
        'cannot restore while a diff rejection is running',
      )
      await expect(orchestrator.undoRestore(thread.id, undo)).rejects.toThrow(
        'cannot restore while a diff rejection is running',
      )
    } finally {
      release(heldSnapshot)
      await reviewing.catch(() => undefined)
    }
  })

  it('refuses hunk and file rejection while a checkpoint restore is still in progress', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    const first = orchestrator.checkpoints(thread.id)[0]!

    let release = (_value: checkpoint.Snapshot) => {}
    const restoreSnapshot = vi
      .spyOn(checkpoint, 'restoreSnapshot')
      .mockClear()
      .mockReturnValueOnce(new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)))
    const restoring = orchestrator.restoreCheckpoint(thread.id, first.id)
    await vi.waitFor(() => expect(restoreSnapshot).toHaveBeenCalledTimes(1))

    try {
      await expect(
        orchestrator.reviewHunk(thread.id, 'version', 'file.txt', 'hunk', 'reject'),
      ).rejects.toThrow('Refresh the diff and try again.')
      await expect(
        orchestrator.reviewFile(thread.id, 'version', 'file.txt', 'reject'),
      ).rejects.toThrow('Refresh the diff and try again.')
    } finally {
      release({ commit: 'replaced', clean: false })
      await restoring
    }
  })

  it('does not fail a turn just because the folder is not a repository', async () => {
    const { orchestrator } = harness()
    const plain = mkdtempSync(path.join(os.tmpdir(), 'harness-plain-'))

    const thread = await orchestrator.startThread('codex', plain)
    // A backup the user never asked for must not be able to block their work.
    await expect(orchestrator.sendTurn(thread.id, 'a task')).resolves.toBeDefined()
    expect(orchestrator.checkpoints(thread.id)).toEqual([])

    rmSync(plain, { recursive: true, force: true })
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

describe('overnight race pins', () => {
  it('disposes a resume that lands after the thread was closed', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({ id: 'thread-1', projectPath: '/repo', provider: 'codex', title: 'T' })
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const session = new FakeSession('s1')
    const orchestrator = new Orchestrator(store, {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      mcpConfig: new McpConfigStore(
        path.join(mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-')), 'mcp.json'),
      ),
      readCredential: () => '',
      runtimeFor: () => ({
        async start() {
          throw new Error('start is not under test')
        },
        async listModels() {
          return []
        },
        async resume(threadId: string, workspacePath: string) {
          await barrier
          return {
            thread: { id: threadId, provider: 'codex' as const, workspacePath, createdAt: 1 },
            session,
          }
        },
      }),
    })

    const resuming = orchestrator.submitTurn('thread-1', 'hello')
    resuming.catch(() => undefined)
    // Let the resume begin, close the thread underneath it, then let the
    // provider "answer".
    await new Promise((resolve) => setTimeout(resolve, 0))
    orchestrator.close('thread-1')
    release()

    await expect(resuming).rejects.toThrow(/closed while resuming/)
    // The late session must be disposed, never attached as a zombie.
    expect(session.disposed).toBe(true)
  })
})

describe('panic versus an in-flight queue drain', () => {
  it('a drain that already grabbed a prompt cannot start it after panic', async () => {
    const { orchestrator, sessions, store } = harness()
    store.addProject('/repo')
    const thread = await orchestrator.startThread('codex', '/repo')
    const session = sessions[0]!

    // Turn A active, turn B queued behind it.
    await orchestrator.submitTurn(thread.id, 'turn A')
    const queued = await orchestrator.submitTurn(thread.id, 'turn B')
    expect(queued.queued).toBe(true)

    // Hold the next sendTurn open, then complete A so the drain grabs B and
    // blocks inside the adapter call.
    session.release = () => {}
    session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const panic = orchestrator.panicStop()
    session.release?.()
    await panic
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The panicked drain must not leave turn B running or re-queued.
    expect(orchestrator.inboxStatus(thread.id)).not.toBe('working')
    expect(orchestrator.queue(thread.id).items).toEqual([])
  })
})
