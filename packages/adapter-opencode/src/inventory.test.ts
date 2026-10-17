import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { methods, SkillSchema } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenCodeAdapter } from './adapter.js'
import {
  mapOpenCodeCommands,
  mapOpenCodeMcpServers,
  mapOpenCodeSkills,
  OPENCODE_MCP_CAPABILITIES,
} from './inventory.js'

/**
 * `GET /command`, `/skill` and `/mcp?directory=` of opencode 1.18.13 serve,
 * sanitized: invented paths and skills, templates and skill bodies replaced
 * by markers that must never reach TasteCode.
 */
const captured = JSON.parse(
  readFileSync(new URL('./fixtures/inventory-opencode-1.18.13.json', import.meta.url), 'utf8'),
) as { directory: string; command: unknown[]; skill: unknown[]; mcp: unknown }

describe('OpenCode inventory mapping', () => {
  it('maps commands and skills without their templates', () => {
    const commands = mapOpenCodeCommands(captured.command)
    expect(commands).toEqual([
      { name: 'init', description: 'guided AGENTS.md setup', argumentHint: '[arguments]' },
      {
        name: 'review',
        description: 'review changes [commit|branch|pr], defaults to uncommitted',
        argumentHint: '[arguments]',
      },
      {
        name: 'customize-opencode',
        description: "Use only when editing opencode's own configuration",
        kind: 'skill',
      },
      {
        name: 'release-notes',
        description: 'Draft release notes from merged changes',
        kind: 'skill',
      },
      { name: 'greet', description: 'Greet someone by name', argumentHint: '[arguments]' },
      { name: 'lint-rules', description: 'A project skill', kind: 'skill' },
      { name: 'team-style', description: "A project skill kept with Claude Code's", kind: 'skill' },
    ])
    expect(JSON.stringify(commands)).not.toMatch(/MUST-NOT-LEAK/)
    expect(methods['commands.list'].result.parse({ commands, loading: false }).commands).toEqual(
      commands,
    )
    expect(
      mapOpenCodeCommands([
        { name: 'two', hints: ['$1', '$2', '$1'] },
        { name: '/slash' },
        { name: 'two' },
        { description: 'no name' },
        'text',
      ]),
    ).toEqual([{ name: 'two', description: '', argumentHint: '[arg1] [arg2]' }])
    expect(mapOpenCodeCommands({ data: [] })).toEqual([])
  })

  it('scopes skills by where OpenCode found them', () => {
    const skills = mapOpenCodeSkills(captured.skill, captured.directory)
    expect(skills.map(({ id, scope, source }) => ({ id, scope, source }))).toEqual([
      { id: 'opencode:customize-opencode', scope: 'system', source: { type: 'provider' } },
      {
        id: 'C:\\Users\\example\\.claude\\skills\\release-notes\\SKILL.md',
        scope: 'user',
        source: { type: 'folder', path: 'C:\\Users\\example\\.claude\\skills\\release-notes' },
      },
      {
        id: 'C:\\work\\project\\.opencode\\skills\\lint-rules\\SKILL.md',
        scope: 'project',
        source: { type: 'folder', path: 'C:\\work\\project\\.opencode\\skills\\lint-rules' },
      },
      {
        id: 'C:\\work\\project\\.claude\\skills\\team-style\\SKILL.md',
        scope: 'project',
        source: { type: 'folder', path: 'C:\\work\\project\\.claude\\skills\\team-style' },
      },
    ])
    for (const skill of skills) expect(SkillSchema.parse(skill)).toEqual(skill)
    expect(JSON.stringify(skills)).not.toMatch(/MUST-NOT-LEAK/)
    expect(
      mapOpenCodeSkills(
        [{ name: 'notes', location: '/home/dev/project/.opencode/skills/notes/SKILL.md' }],
        '/home/dev/project',
      )[0]!.scope,
    ).toBe('project')
    // A sibling folder that only starts with the project's name is not the project.
    expect(
      mapOpenCodeSkills(
        [{ name: 'notes', location: '/home/dev/project-old/skills/notes/SKILL.md' }],
        '/home/dev/project',
      )[0]!.scope,
    ).toBe('user')
  })

  it('maps MCP status, including the states the served OpenAPI documents', () => {
    const servers = mapOpenCodeMcpServers({
      ...(captured.mcp as object),
      remote: { status: 'needs_auth' },
      registered: { status: 'needs_client_registration', error: 'Registration refused' },
      odd: { nope: true },
    })
    expect(
      servers.map(({ id, enabled, auth, startup }) => ({ id, enabled, auth, startup })),
    ).toEqual([
      { id: 'demo', enabled: true, auth: { status: 'not_required' }, startup: { state: 'ready' } },
      {
        id: 'broken',
        enabled: true,
        auth: { status: 'not_required' },
        startup: {
          state: 'failed',
          message: 'SSE error: Unable to connect. Is the computer able to access the url?',
        },
      },
      {
        id: 'off',
        enabled: false,
        auth: { status: 'not_required' },
        startup: { state: 'stopped' },
      },
      {
        id: 'remote',
        enabled: true,
        auth: { status: 'sign_in_required', method: 'oauth' },
        startup: { state: 'stopped' },
      },
      {
        id: 'registered',
        enabled: true,
        auth: { status: 'sign_in_required', method: 'oauth' },
        startup: { state: 'failed', message: 'Registration refused' },
      },
    ])
    expect(
      methods['mcp.list'].result.parse({ capabilities: OPENCODE_MCP_CAPABILITIES, servers })
        .servers,
    ).toEqual(servers)
    expect(mapOpenCodeMcpServers(null)).toEqual([])
  })
})

describe('OpenCode inventory reads', () => {
  const servers: Server[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('reads a directory from the running server', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const body =
        url.pathname === '/api/health'
          ? { healthy: true }
          : url.pathname === '/command'
            ? captured.command
            : url.pathname === '/skill'
              ? captured.skill
              : url.pathname === '/mcp'
                ? captured.mcp
                : undefined
      response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body ?? {}))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const adapter = new OpenCodeAdapter({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    })
    await expect(adapter.listCommands()).rejects.toThrow('OpenCode is not running')
    await adapter.start()
    await expect(adapter.commands(captured.directory)).resolves.toHaveLength(7)
    await expect(adapter.skills(captured.directory)).resolves.toHaveLength(4)
    await expect(adapter.mcpServers(captured.directory)).resolves.toHaveLength(3)
    const directory = encodeURIComponent(captured.directory)
    expect(requests.filter((url) => url !== '/api/health')).toEqual([
      `/command?directory=${directory}`,
      `/skill?directory=${directory}`,
      `/mcp?directory=${directory}`,
    ])
    await adapter.dispose()
  })
})
