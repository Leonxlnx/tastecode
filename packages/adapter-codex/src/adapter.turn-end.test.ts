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

const THREAD = 'thread-1'
const TURN = 'turn-1'

/**
 * Item shapes as codex-cli 0.163.0 app-server sends them
 * (fixtures/subagent-codex-0.163.jsonl). The order is a Codex 0.163 rollout on
 * gpt-6.1: the agent started `npm run start -- -p 4175` as a unified-exec process,
 * finished its turn, and the command completed five minutes later, when the server
 * exited with code 1 after 485 s.
 */
function command(status: string, extra: Record<string, JsonRpcValue> = {}): JsonRpcValue {
  return {
    type: 'commandExecution',
    id: 'exec-server',
    pluginId: null,
    scriptPath: null,
    command: 'C:\\WINDOWS\\system32\\cmd.exe /c npm run start -- -p 4175',
    cwd: 'C:\\project',
    processId: '21164',
    source: 'unifiedExecStartup',
    status,
    commandActions: [{ type: 'unknown', command: 'npm run start -- -p 4175' }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...extra,
  }
}

function message(id: string, phase: 'commentary' | 'final_answer', text: string): JsonRpcValue {
  return {
    type: 'agentMessage',
    id,
    text,
    phase,
    memoryCitation: null,
    delivery: null,
    questions: null,
  }
}

const adapters: CodexAdapter[] = []

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
})

async function runningTurn() {
  const rpc = new FakeCodexRpc((method) => {
    if (method === 'thread/start') return { thread: { id: THREAD }, model: 'gpt-6.1-terra' }
    if (method === 'turn/start') return { turn: { id: TURN } }
    return {}
  })
  proc.rpc = rpc
  const adapter = new CodexAdapter()
  adapters.push(adapter)
  const events: DomainEvent[] = []
  adapter.on('event', (event) => events.push(event))
  await adapter.start()
  await adapter.startThread('C:\\project')
  await adapter.sendTurn(THREAD, 'Build and start the site')
  const started = (item: JsonRpcValue, at: number) =>
    rpc.emitNotification('item/started', { item, threadId: THREAD, turnId: TURN, startedAtMs: at })
  const completed = (item: JsonRpcValue, at: number) =>
    rpc.emitNotification('item/completed', {
      item,
      threadId: THREAD,
      turnId: TURN,
      completedAtMs: at,
    })
  const endTurn = (status: 'completed' | 'failed' | 'interrupted') =>
    rpc.emitNotification('turn/completed', {
      threadId: THREAD,
      turn: {
        id: TURN,
        items: [],
        itemsView: 'summary',
        status,
        error: null,
        startedAt: 1_000,
        completedAt: 1_300,
        durationMs: 300_000,
      },
    })
  return { rpc, events, started, completed, endTurn }
}

/** The lifecycle events of the turn, without the user's own prompt. */
function lifecycle(events: DomainEvent[]) {
  return events.flatMap((event) => {
    if (event.type === 'turn.completed') return [`turn ${event.status}`]
    if (event.type !== 'item.started' && event.type !== 'item.completed') return []
    return [`${event.item.id} ${event.item.status}`]
  })
}

describe('a Codex turn that ends while its work still runs', () => {
  it('ends a server the agent left running with the turn, then takes its exit', async () => {
    const { rpc, events, started, completed, endTurn } = await runningTurn()
    started(message('note', 'commentary', ''), 1_000)
    completed(message('note', 'commentary', 'Starting the server.'), 1_100)
    started(command('inProgress'), 1_200)
    rpc.emitNotification('item/commandExecution/outputDelta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'exec-server',
      delta: 'ready on http://127.0.0.1:4175\r\n',
    })
    started(message('answer', 'final_answer', ''), 1_250)
    completed(message('answer', 'final_answer', 'The site runs on port 4175.'), 1_260)
    endTurn('completed')

    expect(lifecycle(events)).toEqual([
      'note started',
      'note completed',
      'exec-server started',
      'answer started',
      'answer completed',
      'exec-server completed',
      'turn completed',
    ])
    const settled = events.findLast(
      (event) => event.type === 'item.completed' && event.item.id === 'exec-server',
    )
    // Without text, so the output that streamed in stays; without an exit code, since
    // the process has none yet.
    expect(settled).toEqual({
      type: 'item.completed',
      item: {
        id: 'exec-server',
        turnId: TURN,
        type: 'command',
        status: 'completed',
        command: 'C:\\WINDOWS\\system32\\cmd.exe /c npm run start -- -p 4175',
        createdAt: 1_200,
      },
    })

    // The process exits minutes later and Codex reports it under the same turn.
    completed(
      command('failed', {
        aggregatedOutput: 'ready on http://127.0.0.1:4175\r\n',
        exitCode: 1,
        durationMs: 485_582,
      }),
      301_200,
    )
    expect(events.at(-1)).toEqual({
      type: 'item.completed',
      item: expect.objectContaining({ id: 'exec-server', status: 'failed', exitCode: 1 }),
    })
    expect(lifecycle(events).filter((entry) => entry === 'turn completed')).toHaveLength(1)
  })

  it('settles only what is still open, and a failed turn as failed', async () => {
    const { events, started, completed, endTurn } = await runningTurn()
    started(command('inProgress', { id: 'exec-build', command: 'npm run build' }), 1_000)
    completed(
      command('completed', { id: 'exec-build', command: 'npm run build', exitCode: 0 }),
      1_100,
    )
    started(command('inProgress'), 1_200)
    endTurn('failed')

    expect(lifecycle(events)).toEqual([
      'exec-build started',
      'exec-build completed',
      'exec-server started',
      'exec-server failed',
      'turn failed',
    ])
  })

  it('leaves a stopped turn its unfinished work, which reads as interrupted', async () => {
    const { events, started, endTurn } = await runningTurn()
    started(command('inProgress'), 1_000)
    endTurn('interrupted')

    expect(lifecycle(events)).toEqual(['exec-server started', 'turn interrupted'])
  })

  it('takes a Stop that arrives after the turn ended as nothing to do', async () => {
    const { rpc, endTurn } = await runningTurn()
    endTurn('completed')

    await expect(adapters[0]!.interrupt(THREAD)).resolves.toBeUndefined()
    expect(rpc.calls.map((call) => call.method)).not.toContain('turn/interrupt')
  })
})
