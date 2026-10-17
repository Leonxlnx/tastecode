import type { McpCapabilities, McpServer, ProviderCommand } from '@harness/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectInventoryCache,
  type ProjectInventory,
  type ProjectInventoryCacheOptions,
} from './project-inventory-cache.js'

const capabilities: McpCapabilities = {
  inventory: true,
  add: true,
  update: true,
  remove: true,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
  hideInherited: false,
}

const command = (name: string): ProviderCommand => ({ name, description: `${name} command` })
const server = (id: string, state: 'starting' | 'ready' = 'ready'): McpServer => ({
  id,
  scope: 'global',
  enabled: true,
  auth: { status: 'not_required' },
  startup: { state },
  tools: [],
  resources: [],
  resourceTemplates: [],
})

type Probe = {
  projectPath: string
  signal: AbortSignal
  update: (inventory: ProjectInventory) => void
  resolve: (inventory: ProjectInventory) => void
  reject: (error: unknown) => void
}

function setup(options: Partial<ProjectInventoryCacheOptions> = {}) {
  const probes: Probe[] = []
  const changes: Array<[string, string[]]> = []
  const errors: unknown[] = []
  const cache = new ProjectInventoryCache({
    service: {
      mcpCapabilities: capabilities,
      discover: (projectPath, { signal, onUpdate }) =>
        new Promise((resolve, reject) => {
          probes.push({ projectPath, signal, update: onUpdate, resolve, reject })
          signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        }),
    },
    onChanged: (projectPath, parts) => changes.push([projectPath, parts]),
    onError: (_projectPath, error) => errors.push(error),
    ttlMs: 60_000,
    timeoutMs: 45_000,
    retryMs: 30_000,
    ...options,
  })
  return { cache, probes, changes, errors }
}

const full: ProjectInventory = {
  commands: [command('context'), command('code-review')],
  servers: [server('docs')],
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('project inventory cache', () => {
  it('starts one probe per project and reports its early and final answers', async () => {
    const { cache, probes, changes } = setup()

    await expect(cache.listMcpServers('/repo')).resolves.toEqual({
      capabilities,
      servers: [],
      loading: true,
    })
    await expect(cache.listCommands('/repo')).resolves.toEqual({ commands: [], loading: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes.map((probe) => probe.projectPath)).toEqual(['/repo'])

    // Claude answers init with its commands while servers still start.
    probes[0]!.update({ commands: full.commands, servers: [server('docs', 'starting')] })
    expect(changes).toEqual([['/repo', ['commands', 'mcp']]])
    await expect(cache.listCommands('/repo')).resolves.toEqual({
      commands: full.commands,
      loading: false,
    })
    await expect(cache.listMcpServers('/repo')).resolves.toEqual({
      capabilities,
      servers: [server('docs', 'starting')],
      loading: true,
    })

    probes[0]!.resolve(full)
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([
      ['/repo', ['commands', 'mcp']],
      ['/repo', ['mcp']],
    ])
    await expect(cache.listMcpServers('/repo')).resolves.toEqual({
      capabilities,
      servers: full.servers,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(1)
  })

  it('answers an expired project at once and refreshes it behind the answer', async () => {
    const { cache, probes, changes } = setup()
    await cache.listCommands('/repo')
    await vi.advanceTimersByTimeAsync(0)
    probes[0]!.resolve(full)
    await vi.advanceTimersByTimeAsync(59_000)
    changes.length = 0

    await cache.listCommands('/repo')
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(cache.listCommands('/repo')).resolves.toEqual({
      commands: full.commands,
      loading: false,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(2)
    // The same answer is no news.
    probes[1]!.resolve(full)
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([])

    await vi.advanceTimersByTimeAsync(60_000)
    await cache.listMcpServers('/repo')
    await vi.advanceTimersByTimeAsync(0)
    probes[2]!.resolve({ ...full, servers: [...full.servers, server('notes')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([['/repo', ['mcp']]])
  })

  it('runs one probe at a time across projects', async () => {
    const { cache, probes } = setup()
    await cache.listMcpServers('/a')
    await cache.listMcpServers('/b')
    await cache.listCommands('/a')
    await vi.advanceTimersByTimeAsync(0)
    expect(probes.map((probe) => probe.projectPath)).toEqual(['/a'])

    probes[0]!.resolve(full)
    await vi.advanceTimersByTimeAsync(0)
    expect(probes.map((probe) => probe.projectPath)).toEqual(['/a', '/b'])
  })

  it("prefers a live chat's answer and keeps it after the chat is gone", async () => {
    const { cache, probes } = setup()
    const live = [command('from-chat')]

    await expect(cache.listCommands('/repo', async () => live)).resolves.toEqual({
      commands: live,
      loading: false,
    })
    await expect(
      cache.listMcpServers('/repo', async () => ({
        servers: [server('docs', 'starting')],
        loading: true,
      })),
    ).resolves.toMatchObject({ loading: true })
    await expect(
      cache.listMcpServers('/repo', async () => ({ servers: [server('docs')] })),
    ).resolves.toEqual({ capabilities, servers: [server('docs')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toEqual([])

    // The chat closed; its last answers still serve.
    await expect(cache.listCommands('/repo')).resolves.toEqual({ commands: live, loading: false })
    await expect(cache.listMcpServers('/repo')).resolves.toEqual({
      capabilities,
      servers: [server('docs')],
    })
    // A chat that closes during the read leaves the cached answer.
    await expect(
      cache.listCommands('/repo', async () => {
        throw new Error('Claude session closed.')
      }),
    ).resolves.toEqual({ commands: live, loading: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toEqual([])
  })

  it('keeps a live answer that arrives while a probe runs', async () => {
    const { cache, probes } = setup()
    await cache.listCommands('/repo')
    await vi.advanceTimersByTimeAsync(1_000)
    await cache.listCommands('/repo', async () => [command('from-chat')])
    probes[0]!.resolve(full)
    await vi.advanceTimersByTimeAsync(0)
    await expect(cache.listCommands('/repo')).resolves.toEqual({
      commands: [command('from-chat')],
      loading: false,
    })
    await expect(cache.listMcpServers('/repo')).resolves.toEqual({
      capabilities,
      servers: full.servers,
    })
  })

  it('drops a live server list when TasteCode changes the project servers', async () => {
    const { cache, probes } = setup()
    await cache.listMcpServers('/repo', async () => ({ servers: [server('tastecode-added')] }))
    cache.forgetLiveServers('/repo')
    await expect(cache.listMcpServers('/repo')).resolves.toMatchObject({ loading: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(1)
  })

  it('says unavailable after a failed probe and tries again later', async () => {
    const { cache, probes, changes, errors } = setup()
    await cache.listMcpServers('/repo')
    await vi.advanceTimersByTimeAsync(0)
    probes[0]!.reject(new Error('claude: command not found'))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toHaveLength(1)
    // The reader that was told "loading" hears that it ended.
    expect(changes).toEqual([['/repo', ['mcp']]])
    await expect(cache.listMcpServers('/repo')).resolves.toEqual({
      capabilities: { ...capabilities, inventory: false },
      servers: [],
    })
    await expect(cache.listCommands('/repo')).resolves.toEqual({ commands: [], loading: false })
    await vi.advanceTimersByTimeAsync(29_000)
    await cache.listCommands('/repo')
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(cache.listCommands('/repo')).resolves.toEqual({ commands: [], loading: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(2)
  })

  it('keeps an expired answer through a failed refresh and waits before the next', async () => {
    const { cache, probes, errors } = setup()
    await cache.listCommands('/repo')
    await vi.advanceTimersByTimeAsync(0)
    probes[0]!.resolve(full)
    await vi.advanceTimersByTimeAsync(60_000)

    await cache.listCommands('/repo')
    await vi.advanceTimersByTimeAsync(0)
    probes[1]!.reject(new Error('Claude Code did not start in time'))
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toHaveLength(1)

    // Readers keep the last answer, and do not start a probe on every read.
    for (let read = 0; read < 3; read += 1) {
      await expect(cache.listCommands('/repo')).resolves.toEqual({
        commands: full.commands,
        loading: false,
      })
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(probes).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(27_000)
    await cache.listMcpServers('/repo')
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(3)
  })

  it('stops a probe that runs past its time limit', async () => {
    const { cache, probes, changes } = setup()
    await cache.listCommands('/repo')
    await vi.advanceTimersByTimeAsync(44_000)
    expect(probes[0]!.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(probes[0]!.signal.aborted).toBe(true)
    expect(changes).toEqual([['/repo', ['commands']]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-reads a project after its configuration changes while someone looks', async () => {
    const listeners: Array<(event: string, filename: string | null) => void> = []
    const watchPaths = vi.fn(() => [{ directory: '/repo', names: ['.mcp.json'] }])
    const { cache, probes, changes } = setup({
      service: {
        mcpCapabilities: capabilities,
        watchPaths,
        discover: (projectPath, { signal, onUpdate }) =>
          new Promise((resolve, reject) => {
            probes.push({ projectPath, signal, update: onUpdate, resolve, reject })
          }),
      },
      watchTtlMs: 60_000,
      watch: (_directory, listener) => {
        listeners.push(listener)
        return { close: () => {}, on: () => ({}) as never }
      },
    })
    await cache.listMcpServers('/repo')
    await vi.advanceTimersByTimeAsync(0)
    probes[0]!.resolve(full)
    await vi.advanceTimersByTimeAsync(0)
    changes.length = 0

    cache.watch('/repo')
    await vi.advanceTimersByTimeAsync(0)
    expect(watchPaths).toHaveBeenCalledWith('/repo')
    listeners[0]!('change', 'README.md')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(changes).toEqual([])
    listeners[0]!('change', '.mcp.json')
    await vi.advanceTimersByTimeAsync(500)
    expect(changes).toEqual([['/repo', ['commands', 'mcp']]])

    // The answer on screen stays while the refresh runs.
    await expect(cache.listMcpServers('/repo')).resolves.toEqual({
      capabilities,
      servers: full.servers,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(2)
    probes[1]!.resolve({ ...full, servers: [server('docs'), server('notes')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([
      ['/repo', ['commands', 'mcp']],
      ['/repo', ['mcp']],
    ])
    cache.clear()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refreshes again when the configuration changed during a probe', async () => {
    const { cache, probes, changes } = setup()
    expect(cache.invalidate('/unknown')).toBe(false)
    await cache.listCommands('/repo')
    await vi.advanceTimersByTimeAsync(0)
    expect(cache.invalidate('/repo')).toBe(true)
    probes[0]!.resolve(full)
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([['/repo', ['commands', 'mcp']]])
    // Nobody has to read again: the next probe starts on its own.
    expect(probes).toHaveLength(2)
    await expect(cache.listCommands('/repo')).resolves.toEqual({
      commands: full.commands,
      loading: false,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(2)

    // The change it was started for shows up in its answer and is reported.
    probes[1]!.resolve({ ...full, commands: [...full.commands, command('added')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([
      ['/repo', ['commands', 'mcp']],
      ['/repo', ['commands']],
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(2)
  })

  it("answers a provider's skills from the same probe when it declares them", async () => {
    const skillCapabilities = { inventory: true, configure: false, install: false }
    const listeners: Array<(event: string, filename: string | null) => void> = []
    const skill = {
      id: '/home/dev/.grok/skills/help/SKILL.md',
      name: 'help',
      description: 'Help',
      source: { type: 'folder' as const, path: '/home/dev/.grok/skills/help' },
      scope: 'user' as const,
      enabled: true,
      dependencyErrors: [],
    }
    const { cache, probes, changes } = setup({
      service: {
        mcpCapabilities: capabilities,
        skillCapabilities,
        watchPaths: () => [{ directory: '/repo/.grok' }],
        discover: (projectPath, { signal, onUpdate }) =>
          new Promise((resolve, reject) => {
            probes.push({ projectPath, signal, update: onUpdate, resolve, reject })
          }),
      },
      watch: (_directory, listener) => {
        listeners.push(listener)
        return { close: () => {}, on: () => ({}) as never }
      },
    })

    expect(cache.listSkills('/repo')).toEqual({
      capabilities: skillCapabilities,
      skills: [],
      errors: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(probes).toHaveLength(1)
    probes[0]!.resolve({ ...full, skills: [skill] })
    await vi.advanceTimersByTimeAsync(0)
    expect(changes.map(([projectPath, parts]) => [projectPath, [...parts].sort()])).toEqual([
      ['/repo', ['commands', 'mcp', 'skills']],
    ])
    expect(cache.listSkills('/repo')).toEqual({
      capabilities: skillCapabilities,
      skills: [skill],
      errors: [],
    })

    // A look at the skills alone keeps the configuration watched, and a change names them.
    changes.length = 0
    cache.watch('/repo', ['skills'])
    await vi.advanceTimersByTimeAsync(0)
    listeners[0]!('change', 'skills')
    await vi.advanceTimersByTimeAsync(500)
    expect(changes).toEqual([['/repo', ['commands', 'mcp', 'skills']]])
    cache.clear()
  })

  it('has no skills to show without the declaration or after a failed probe', async () => {
    const plain = setup()
    expect(plain.cache.listSkills('/repo')).toEqual({
      capabilities: { inventory: false, configure: false, install: false },
      skills: [],
      errors: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(plain.probes).toEqual([])
    // Only a look at a part this inventory answers takes a watch lease.
    const watchPaths = vi.fn(() => [])
    const watched = setup({
      service: { mcpCapabilities: capabilities, watchPaths, discover: async () => full },
    })
    watched.cache.watch('/repo', ['skills'])
    await vi.advanceTimersByTimeAsync(0)
    expect(watchPaths).not.toHaveBeenCalled()

    const skillCapabilities = { inventory: true, configure: false, install: false }
    const failing = setup({
      service: {
        mcpCapabilities: capabilities,
        skillCapabilities,
        discover: async () => {
          throw new Error('grok: command not found')
        },
      },
    })
    expect(failing.cache.listSkills('/repo').capabilities).toEqual(skillCapabilities)
    await vi.advanceTimersByTimeAsync(0)
    expect(failing.changes).toEqual([['/repo', ['skills']]])
    expect(failing.cache.listSkills('/repo')).toEqual({
      capabilities: { inventory: false, configure: false, install: false },
      skills: [],
      errors: [],
    })
  })

  it('stops probes and stays quiet once cleared or forgotten', async () => {
    const { cache, probes, changes } = setup()
    await cache.listCommands('/a')
    await cache.listCommands('/b')
    await vi.advanceTimersByTimeAsync(0)
    cache.forget('/a')
    expect(probes[0]!.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(probes.map((probe) => probe.projectPath)).toEqual(['/a', '/b'])
    cache.clear()
    expect(probes[1]!.signal.aborted).toBe(true)
    probes[1]!.resolve(full)
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
