import { readFileSync } from 'node:fs'
import type { McpServerStatus, Options, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverClaudeProject, readClaudeProjectInventory } from './discovery.js'
import type { ClaudeQueryFactory, ClaudeQueryRuntime } from './sdk-runtime.js'

/** Sanitized from a no-prompt capture of claude 2.1.296; see the fixture's note. */
const capture = JSON.parse(
  readFileSync(new URL('./fixtures/inventory-claude-2.1.296.json', import.meta.url), 'utf8'),
) as {
  initializationResult: { commands: SlashCommand[] }
  mcpServerStatus: { atInit: McpServerStatus[]; settled: McpServerStatus[] }
}

function fakeQuery() {
  let answerInit!: () => void
  const initialized = new Promise<void>((resolve) => (answerInit = resolve))
  const query = {
    status: capture.mcpServerStatus.atInit,
    commands: capture.initializationResult.commands,
    statusReads: 0,
    closed: false,
    answerInit,
    initializationResult: vi.fn(async () => {
      await initialized
      return { commands: capture.initializationResult.commands }
    }),
    mcpServerStatus: vi.fn(async () => {
      query.statusReads += 1
      return query.status
    }),
    supportedCommands: vi.fn(async () => query.commands),
    close: vi.fn(() => {
      query.closed = true
    }),
  }
  return query
}

const runtime = (query: ReturnType<typeof fakeQuery>) => query as unknown as ClaudeQueryRuntime

const ids = (servers: Array<{ id: string; startup?: { state: string } | undefined }>) =>
  servers.map((server) => [server.id, server.startup?.state])

describe('Claude project discovery', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports commands at init, then the servers once they finish starting', async () => {
    vi.useFakeTimers()
    const query = fakeQuery()
    const onUpdate = vi.fn()
    const reading = readClaudeProjectInventory(runtime(query), new AbortController().signal, {
      onUpdate,
    })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(onUpdate).not.toHaveBeenCalled()
    query.answerInit()
    await vi.advanceTimersByTimeAsync(0)

    expect(onUpdate).toHaveBeenCalledOnce()
    const early = onUpdate.mock.calls[0]![0] as Awaited<typeof reading>
    expect(early.commands.map((command) => command.name)).toContain('code-review')
    // TasteCode owns the model and the chat, so their commands stay out.
    expect(early.commands.map((command) => command.name)).not.toContain('model')
    expect(ids(early.servers)).toContainEqual(['plugin:acme-docs:acme-docs', 'starting'])

    await vi.advanceTimersByTimeAsync(1_000)
    query.status = capture.mcpServerStatus.settled
    query.commands = [
      ...capture.initializationResult.commands,
      { name: 'late-skill', description: 'Loaded by a plugin after init', argumentHint: '' },
    ]
    await vi.advanceTimersByTimeAsync(500)
    const inventory = await reading
    expect(ids(inventory.servers)).toContainEqual(['plugin:acme-docs:acme-docs', 'ready'])
    expect(inventory.commands.map((command) => command.name)).toContain('late-skill')
    const reads = query.statusReads
    await vi.advanceTimersByTimeAsync(30_000)
    expect(query.statusReads).toBe(reads)
  })

  it('answers at once when no server is starting', async () => {
    const query = fakeQuery()
    query.status = capture.mcpServerStatus.settled
    query.answerInit()
    const onUpdate = vi.fn()
    const inventory = await readClaudeProjectInventory(
      runtime(query),
      new AbortController().signal,
      {
        onUpdate,
      },
    )
    expect(onUpdate).not.toHaveBeenCalled()
    expect(query.statusReads).toBe(1)
    expect(inventory.servers).toHaveLength(capture.mcpServerStatus.settled.length)
  })

  it('stops waiting for a server that never starts after the settle cap', async () => {
    vi.useFakeTimers()
    const query = fakeQuery()
    query.answerInit()
    const reading = readClaudeProjectInventory(runtime(query), new AbortController().signal, {
      settleMs: 15_000,
    })
    let done = false
    void reading.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(14_000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(done).toBe(true)
    expect(ids((await reading).servers)).toContainEqual(['claude.ai Claude Docs', 'starting'])
    expect(query.statusReads).toBeLessThanOrEqual(31)
  })

  it('gives up when Claude does not answer init in time', async () => {
    vi.useFakeTimers()
    const query = fakeQuery()
    const reading = readClaudeProjectInventory(runtime(query), new AbortController().signal, {
      initTimeoutMs: 30_000,
    })
    const failure = expect(reading).rejects.toThrow('did not start in time')
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
    expect(query.statusReads).toBe(0)
  })

  it('starts Claude like a chat in the project and closes it when canceled', async () => {
    const query = fakeQuery()
    const inputs: Options[] = []
    const createQuery: ClaudeQueryFactory = ({ options }) => {
      inputs.push(options)
      return query as unknown as ClaudeQueryRuntime
    }
    const cancel = new AbortController()
    const discovering = discoverClaudeProject('/work/project', {
      createQuery,
      signal: cancel.signal,
    })
    await Promise.resolve()
    cancel.abort()
    await expect(discovering).rejects.toThrow('canceled')
    expect(query.closed).toBe(true)
    expect(inputs).toHaveLength(1)
    const options = inputs[0]!
    expect(options).toMatchObject({
      cwd: '/work/project',
      settingSources: ['user', 'project', 'local'],
      persistSession: false,
    })
    // Claude's own MCP configuration must load, so nothing restricts or adds to it.
    expect(options.strictMcpConfig).toBeUndefined()
    expect(options.mcpServers).toBeUndefined()
    expect(options.abortController?.signal.aborted).toBe(true)
  })

  it('does not start Claude for a request that is already canceled', async () => {
    const createQuery = vi.fn<ClaudeQueryFactory>()
    const cancel = new AbortController()
    cancel.abort()
    await expect(
      discoverClaudeProject('/work/project', { createQuery, signal: cancel.signal }),
    ).rejects.toThrow()
    expect(createQuery).not.toHaveBeenCalled()
  })
})
