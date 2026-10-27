import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderId } from '@harness/contracts'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AgentSession, ProviderRuntime } from './adapters.js'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { runtimeForLaunch, validateRuntime } from './provider-runtimes.js'
import { Store } from './store.js'

/** What each Claude limit read was asked to start with. */
const limitReads = vi.hoisted(() => [] as unknown[])

vi.mock('@harness/adapter-claude-code', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-claude-code')>()
  return {
    ...original,
    claudeAccount: async () => ({ signedIn: true, email: 'me@example.test' }),
    claudeLimitSource: async (options?: unknown) => {
      limitReads.push(options ?? {})
      return { status: 'ready', limits: [{ id: 'seven_day', label: 'Weekly', usedPercent: 10 }] }
    },
  }
})

const root = mkdtempSync(path.join(os.tmpdir(), 'harness-orchestrator-runtimes-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function session(): AgentSession {
  return {
    capabilities: {
      steer: false,
      fork: false,
      interrupt: true,
      reasoningItems: false,
      approvals: false,
      images: false,
    },
    sendTurn: async () => 'turn-1',
    interrupt: async () => {},
    respondToApproval: () => {},
    dispose: () => {},
    on: () => {},
  }
}

function setup(store = new Store(':memory:')) {
  /** The runtime each launch and model list was given, in order. */
  const runtimes: Array<{ kind: 'start' | 'resume' | 'models'; runtime: string | undefined }> = []
  let started = 0
  const runtimeFor = (provider: ProviderId): ProviderRuntime => ({
    async start(workspacePath, options) {
      runtimes.push({ kind: 'start', runtime: options.runtime })
      started += 1
      return {
        thread: { id: `${provider}-${started}`, provider, workspacePath, createdAt: Date.now() },
        session: session(),
      }
    },
    async resume(threadId, workspacePath, options) {
      runtimes.push({ kind: 'resume', runtime: options.runtime })
      return {
        thread: { id: threadId, provider, workspacePath, createdAt: Date.now() },
        session: session(),
      }
    },
    async listModels(_agent, _read, launch) {
      runtimes.push({ kind: 'models', runtime: launch?.runtime })
      return [{ id: 'opus', displayName: 'Opus', isDefault: true, reasoningEfforts: [] }]
    },
  })
  const orchestrator = new Orchestrator(store, {
    onEvent: () => {},
    onLog: () => {},
    runtimeFor,
    mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
    worktreeRoot: path.join(root, 'trees'),
  })
  return { orchestrator, runtimes, store }
}

describe('provider runtimes', () => {
  it('keeps the default out of launches and drops a runtime no longer declared', () => {
    expect(runtimeForLaunch('claude-code', undefined)).toBeUndefined()
    expect(runtimeForLaunch('claude-code', 'sdk')).toBeUndefined()
    expect(runtimeForLaunch('claude-code', 'cli')).toBe('cli')
    expect(runtimeForLaunch('claude-code', 'retired')).toBeUndefined()
    expect(runtimeForLaunch('codex', 'cli')).toBeUndefined()
  })

  it('refuses a runtime the provider never declared', () => {
    expect(() => validateRuntime('claude-code', 'cli')).not.toThrow()
    expect(() => validateRuntime('claude-code', null)).not.toThrow()
    expect(() => validateRuntime('claude-code', 'retired')).toThrow(
      'This provider cannot run through "retired".',
    )
    expect(() => validateRuntime('codex', 'cli')).toThrow('This provider cannot run through "cli".')
  })

  it('starts Claude chats, model lists and limit reads through the chosen runtime', async () => {
    const { orchestrator, runtimes } = setup()
    expect(orchestrator.runtimeSettings()).toEqual({})
    expect(orchestrator.updateRuntimeSettings('claude-code', 'cli')).toEqual({
      'claude-code': 'cli',
    })

    await orchestrator.listModels('claude-code')
    await orchestrator.startThread('claude-code', root)
    await orchestrator.usageLimitSource('claude-code', 'visible')
    expect(runtimes).toEqual([
      { kind: 'models', runtime: 'cli' },
      { kind: 'start', runtime: 'cli' },
    ])
    expect(limitReads.at(-1)).toEqual({ runtime: 'cli' })

    // Back on the default, launches carry no runtime at all.
    expect(orchestrator.updateRuntimeSettings('claude-code', null)).toEqual({})
    await orchestrator.startThread('claude-code', root)
    expect(runtimes.at(-1)).toEqual({ kind: 'start', runtime: undefined })
    await orchestrator.disposeAll()
  })

  it('leaves other providers and custom harnesses on their own engine', async () => {
    const { orchestrator, runtimes } = setup()
    orchestrator.updateRuntimeSettings('claude-code', 'cli')
    expect(() => orchestrator.updateRuntimeSettings('codex', 'cli')).toThrow(
      'This provider cannot run through "cli".',
    )
    await orchestrator.startThread('codex', root)
    await orchestrator.startThread('claude-code', root, { agent: 'wrapper' })
    expect(runtimes).toEqual([
      { kind: 'start', runtime: undefined },
      { kind: 'start', runtime: undefined },
    ])
    await orchestrator.disposeAll()
  })

  it('reopens a chat after a restart through the runtime chosen now', async () => {
    const first = setup()
    const thread = await first.orchestrator.startThread('claude-code', root)
    await first.orchestrator.disposeAll()

    const second = setup(first.store)
    second.orchestrator.updateRuntimeSettings('claude-code', 'cli')
    // Changing a chat's access level reopens it without starting a turn.
    await second.orchestrator.setThreadApproval(thread.id, 'ask')
    expect(second.runtimes).toEqual([{ kind: 'resume', runtime: 'cli' }])
    await second.orchestrator.disposeAll()
  })
})
