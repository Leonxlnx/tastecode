import type { McpServer, ProviderCommand, Skill } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import { discoverOpenCodeProject, type OpenCodeInventoryReader } from './discovery.js'

const command: ProviderCommand = { name: 'init', description: 'guided AGENTS.md setup' }
const skill: Skill = {
  id: 'opencode:customize-opencode',
  name: 'customize-opencode',
  description: 'Configuration help',
  source: { type: 'provider' },
  scope: 'system',
  enabled: true,
  dependencyErrors: [],
}
const server: McpServer = {
  id: 'docs',
  scope: 'global',
  enabled: true,
  auth: { status: 'not_required' },
  startup: { state: 'ready' },
  tools: [],
  resources: [],
  resourceTemplates: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function reader(servers: Promise<McpServer[]>) {
  const calls: string[] = []
  const fake = {
    start: vi.fn(async () => {
      calls.push('start')
    }),
    dispose: vi.fn(async () => {
      calls.push('dispose')
    }),
    commands: vi.fn(async (directory: string) => {
      calls.push(`commands ${directory}`)
      return [command]
    }),
    skills: vi.fn(async (directory: string) => {
      calls.push(`skills ${directory}`)
      return [skill]
    }),
    mcpServers: vi.fn((directory: string) => {
      calls.push(`mcp ${directory}`)
      return servers
    }),
  } satisfies OpenCodeInventoryReader
  return { fake, calls }
}

describe('OpenCode project discovery', () => {
  it('answers commands and skills early while MCP servers connect, then stops the server', async () => {
    const mcp = deferred<McpServer[]>()
    const { fake, calls } = reader(mcp.promise)
    const updates: unknown[] = []
    const discovery = discoverOpenCodeProject('/repo', {
      createReader: () => fake,
      onUpdate: (inventory) => updates.push(inventory),
    })
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({ commands: [command], servers: [], skills: [skill] })
    expect(fake.dispose).not.toHaveBeenCalled()
    mcp.resolve([server])
    await expect(discovery).resolves.toEqual({
      commands: [command],
      servers: [server],
      skills: [skill],
    })
    expect(calls).toEqual(['start', 'mcp /repo', 'commands /repo', 'skills /repo', 'dispose'])
  })

  it('sends no early answer when MCP is already done', async () => {
    const { fake } = reader(Promise.resolve([server]))
    const onUpdate = vi.fn()
    await expect(
      discoverOpenCodeProject('/repo', { createReader: () => fake, onUpdate }),
    ).resolves.toMatchObject({ servers: [server] })
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('stops the server when canceled or when a read fails', async () => {
    const abort = new AbortController()
    const mcp = deferred<McpServer[]>()
    const { fake } = reader(mcp.promise)
    fake.dispose.mockImplementation(async () => {
      mcp.reject(new Error('OpenCode stopped'))
    })
    const canceled = discoverOpenCodeProject('/repo', {
      createReader: () => fake,
      signal: abort.signal,
    })
    await vi.waitFor(() => expect(fake.skills).toHaveBeenCalled())
    abort.abort()
    await expect(canceled).rejects.toThrow()
    expect(fake.dispose).toHaveBeenCalled()

    const failing = reader(new Promise(() => {}))
    failing.fake.commands.mockRejectedValue(new Error('OpenCode v2 request failed (500)'))
    await expect(
      discoverOpenCodeProject('/repo', { createReader: () => failing.fake }),
    ).rejects.toThrow('(500)')
    expect(failing.fake.dispose).toHaveBeenCalledOnce()
  })
})
