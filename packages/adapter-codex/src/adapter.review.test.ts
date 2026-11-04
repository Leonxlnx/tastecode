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
type Meta = {
  threadId: string
  turnId: string
  reviewerTurnId: string
  reviewStartResponse: JsonRpcValue
}

/**
 * Captured from codex-cli 0.166.0 app-server: `/review` of one uncommitted change on
 * gpt-6-luna, sent as TasteCode sends it. Every notification after thread/start answered,
 * with account, MCP startup and moderation frames dropped and local paths replaced.
 */
const [header, ...frames] = readFileSync(
  new URL('./fixtures/review-codex-0.166.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Frame & { meta?: Meta })
const { threadId: THREAD, turnId: TURN, reviewerTurnId: REVIEWER_TURN } = header!.meta!
/** The frame that starts the reviewer's turn inside the review turn. */
const reviewerStarted = frames.findIndex((frame) => frame.method === 'turn/started')

const adapters: CodexAdapter[] = []

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
})

async function reviewTurn() {
  const rpc = new FakeCodexRpc((method) => {
    if (method === 'thread/start') return { thread: { id: THREAD }, model: 'gpt-6-luna' }
    if (method === 'review/start') return header!.meta!.reviewStartResponse
    return {}
  })
  proc.rpc = rpc
  const adapter = new CodexAdapter()
  adapters.push(adapter)
  const events: DomainEvent[] = []
  adapter.on('event', (event) => events.push(event))
  await adapter.start()
  await adapter.startThread('C:\\project')
  const turnId = await adapter.sendTurn(THREAD, '/review')
  const replay = (selected: Frame[] = frames) => {
    for (const frame of selected) rpc.emitNotification(frame.method, frame.params)
  }
  return { adapter, rpc, events, turnId, replay }
}

function turnIds(events: DomainEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'turn.started') return [event.turn.id]
    if (event.type === 'turn.completed' || event.type === 'item.delta') return [event.turnId]
    if (event.type === 'item.started' || event.type === 'item.completed') return [event.item.turnId]
    return []
  })
}

describe('Codex /review', () => {
  it('ends the review turn when Codex completes it', async () => {
    const { events, turnId, replay } = await reviewTurn()
    expect(turnId).toBe(TURN)
    replay()

    expect(new Set(turnIds(events))).toEqual(new Set([TURN]))
    expect(turnIds(events)).not.toContain(REVIEWER_TURN)
    expect(events.filter((event) => event.type === 'turn.started')).toEqual([
      {
        type: 'turn.started',
        turn: { id: TURN, threadId: THREAD, status: 'running', createdAt: expect.any(Number) },
      },
    ])
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: TURN, status: 'completed' },
    ])
    expect(events.at(-1)).toEqual({ type: 'turn.completed', turnId: TURN, status: 'completed' })
  })

  it('stops the review turn rather than the reviewer turn inside it', async () => {
    const { adapter, rpc, replay } = await reviewTurn()
    replay(frames.slice(0, reviewerStarted + 1))

    await adapter.interrupt(THREAD)
    expect(rpc.calls.find((call) => call.method === 'turn/interrupt')?.params).toEqual({
      threadId: THREAD,
      turnId: TURN,
    })
  })
})
