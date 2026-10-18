import { readFileSync } from 'node:fs'
import type { McpServerStatus, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import { methods, McpCapabilitiesSchema } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { CLAUDE_MCP_CAPABILITIES } from './capabilities.js'
import { mapClaudeCommands, mapClaudeMcpServer, mapClaudeMcpServers } from './inventory.js'

/** Sanitized from a no-prompt capture of claude 2.1.296; see the fixture's note. */
const capture = JSON.parse(
  readFileSync(new URL('./fixtures/inventory-claude-2.1.296.json', import.meta.url), 'utf8'),
) as {
  initializationResult: { commands: SlashCommand[] }
  systemInit: { skills: string[]; terminal_slash_commands: string[] }
  mcpServerStatus: { atInit: McpServerStatus[]; settled: McpServerStatus[] }
}

const hints = {
  skills: new Set(capture.systemInit.skills),
  terminal: new Set(capture.systemInit.terminal_slash_commands),
}

describe('Claude Code commands', () => {
  it('offers what the composer may run and hides what TasteCode owns', () => {
    const commands = mapClaudeCommands(capture.initializationResult.commands, hints)
    expect(commands.map((command) => command.name)).toEqual([
      'release-notes',
      'deep-research',
      'acme-docs:acme-docs',
      'design',
      'code-review',
      'simplify',
      'loop',
      'compact',
      'context',
      'init',
      'mcp',
      'security-review',
      'usage-credits',
      'usage',
      'goal',
      'pdf',
      'anthropic-skills:deep-research',
      'standup',
    ])
    const result = methods['commands.list'].result.parse({ commands, loading: false })
    expect(result.commands).toEqual(commands)
  })

  it('keeps hints and aliases, and marks skills by name or alias', () => {
    const commands = new Map(
      mapClaudeCommands(capture.initializationResult.commands, hints).map((command) => [
        command.name,
        command,
      ]),
    )
    expect(commands.get('code-review')).toEqual({
      name: 'code-review',
      description:
        'Review the current diff, or a PR number/branch/path target, for correctness bugs',
      argumentHint:
        '[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]',
      aliases: ['review'],
      kind: 'skill',
    })
    // An empty hint is left out, and the plugin skill keeps its short alias.
    expect(commands.get('acme-docs:acme-docs')).toEqual({
      name: 'acme-docs:acme-docs',
      description: '(acme-docs) Write documentation in the Acme house style',
      aliases: ['acme-docs'],
      kind: 'skill',
    })
    // system/init lists this skill under its alias.
    expect(commands.get('pdf')?.kind).toBe('skill')
    expect(commands.get('usage')).toEqual({
      name: 'usage',
      description: "Show session cost, plan usage, and what's contributing to your limits",
      aliases: ['cost', 'stats'],
    })
    expect(commands.get('standup')?.kind).toBeUndefined()
  })

  it('uses the captured terminal list until system/init reports one', () => {
    const before = mapClaudeCommands(capture.initializationResult.commands)
    expect(before.map((command) => command.name)).toEqual(
      mapClaudeCommands(capture.initializationResult.commands, hints).map(
        (command) => command.name,
      ),
    )
    expect(before.some((command) => command.kind)).toBe(false)
    const reported = mapClaudeCommands(capture.initializationResult.commands, {
      terminal: new Set(['loop']),
    }).map((command) => command.name)
    expect(reported).toContain('doctor')
    expect(reported).not.toContain('loop')
  })

  it('drops names the contract cannot carry and repeated entries', () => {
    const commands = mapClaudeCommands([
      { name: 'ok', description: 'First', argumentHint: 'x'.repeat(260), aliases: ['ok', 'a b'] },
      { name: 'ok', description: 'Again', argumentHint: '' },
      { name: '/slash', description: '', argumentHint: '' },
      { name: 'two words', description: '', argumentHint: '' },
      { name: '__internal', description: '', argumentHint: '' },
    ])
    expect(commands).toEqual([
      { name: 'ok', description: 'First', argumentHint: expect.any(String) },
    ])
    expect(commands[0]!.argumentHint).toHaveLength(200)
    expect(methods['commands.list'].result.safeParse({ commands, loading: false }).success).toBe(
      true,
    )
  })
})

describe('Claude Code MCP servers', () => {
  it('maps the status list at init, while servers still start', () => {
    const servers = mapClaudeMcpServers(capture.mcpServerStatus.atInit)
    expect(
      servers.map((server) => [server.id, server.displayName, server.description, server.startup]),
    ).toEqual([
      ['plugin:acme-docs:acme-docs', 'acme-docs', 'Plugin acme-docs', { state: 'starting' }],
      ['issue-tracker', undefined, 'Claude Code user settings', { state: 'stopped' }],
      ['project-notes', undefined, 'Added by TasteCode', { state: 'ready' }],
      ['claude.ai Claude Docs', 'Claude Docs', 'claude.ai connector', { state: 'starting' }],
      ['claude.ai Gmail', 'Gmail', 'claude.ai connector', { state: 'stopped' }],
    ])
    expect(servers.find((server) => server.id === 'issue-tracker')?.auth).toEqual({
      status: 'sign_in_required',
      method: 'oauth',
    })
  })

  it('maps settled servers with their tools and versions and no transport', () => {
    const servers = mapClaudeMcpServers(capture.mcpServerStatus.settled)
    expect(servers[0]).toEqual({
      id: 'plugin:acme-docs:acme-docs',
      displayName: 'acme-docs',
      description: 'Plugin acme-docs',
      version: '0.5.0',
      scope: 'global',
      enabled: true,
      auth: { status: 'not_required' },
      startup: { state: 'ready' },
      tools: [
        { name: 'search_docs', inputSchema: {} },
        { name: 'write_page', inputSchema: {} },
        { name: 'fetch_asset', inputSchema: {} },
      ],
      resources: [],
      resourceTemplates: [],
    })
    // Neither the plugin's absolute path nor a connector's proxy config reaches the client.
    expect(JSON.stringify(servers)).not.toMatch(/server\.js|mcpsrv_|claudeai-proxy|googleapis/)
    const result = methods['mcp.list'].result.parse({
      capabilities: CLAUDE_MCP_CAPABILITIES,
      servers,
    })
    expect(result.servers).toEqual(servers)
  })

  it('maps the remaining scopes and states', () => {
    const base = { name: 'docs', config: { type: 'http' as const, url: 'https://docs.test/mcp' } }
    expect(mapClaudeMcpServer({ ...base, status: 'connected', scope: 'project' }).description).toBe(
      'Project .mcp.json',
    )
    expect(mapClaudeMcpServer({ ...base, status: 'connected', scope: 'local' }).description).toBe(
      'Local project settings',
    )
    expect(mapClaudeMcpServer({ ...base, status: 'connected', scope: 'managed' }).description).toBe(
      'Managed',
    )
    expect(mapClaudeMcpServer({ ...base, status: 'connected' }).description).toBeUndefined()
    const disabled = mapClaudeMcpServer({ ...base, status: 'disabled', scope: 'user' })
    expect([disabled.enabled, disabled.startup]).toEqual([false, { state: 'stopped' }])
    expect(
      mapClaudeMcpServer({ ...base, status: 'failed', error: 'token sk-secret rejected' }, (text) =>
        text.replace('sk-secret', '[REDACTED]'),
      ).startup,
    ).toEqual({ state: 'failed', message: 'token [REDACTED] rejected' })
    expect(mapClaudeMcpServer({ ...base, status: 'failed', error: ' ' }).startup).toEqual({
      state: 'failed',
      message: 'MCP server failed to start',
    })
  })

  it('keeps one row per name', () => {
    const servers = mapClaudeMcpServers([
      { name: 'docs', status: 'connected' },
      { name: 'docs', status: 'failed' },
    ])
    expect(servers.map((server) => server.startup)).toEqual([{ state: 'ready' }])
  })

  it('declares inherited servers read-only', () => {
    expect(McpCapabilitiesSchema.parse(CLAUDE_MCP_CAPABILITIES)).toEqual({
      inventory: true,
      add: true,
      update: true,
      remove: true,
      reload: false,
      startOAuth: false,
      cancelOAuth: false,
      hideInherited: false,
    })
  })
})
