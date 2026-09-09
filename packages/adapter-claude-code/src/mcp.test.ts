import type { McpServerConfig } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { ClaudeMcpRedactor, prepareClaudeMcpServers } from './mcp.js'

describe('Claude project MCP config', () => {
  it('resolves credential and literal values only into their target transport config', () => {
    const secret = `canary-${crypto.randomUUID()}`
    const prepared = prepareClaudeMcpServers(
      [
        {
          id: 'local',
          enabled: true,
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['server.mjs'],
            environment: {
              TOKEN: { source: 'credential', credentialRef: 'mcp/token' },
              MODE: { source: 'literal', value: 'test' },
            },
          },
        },
        {
          id: 'remote',
          enabled: true,
          transport: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: { source: 'credential', credentialRef: 'mcp/token' } },
          },
        },
      ],
      { 'mcp/token': secret },
    )
    expect(prepared).toEqual({
      servers: {
        local: {
          type: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          env: { TOKEN: secret, MODE: 'test' },
        },
        remote: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: secret },
        },
      },
      secrets: [secret],
    })
  })

  it('rejects missing, empty, or inherited credentials', () => {
    const servers: McpServerConfig[] = [
      {
        id: 'remote',
        enabled: true,
        transport: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: { source: 'credential', credentialRef: 'constructor' } },
        },
      },
    ]
    for (const credentials of [{}, { constructor: '' }])
      expect(() => prepareClaudeMcpServers(servers, credentials)).toThrow('is unavailable')
    const own = Object.fromEntries([['constructor', 'own-value']])
    expect(prepareClaudeMcpServers(servers, own).servers.remote).toMatchObject({
      headers: { Authorization: 'own-value' },
    })
  })

  it('rejects configs the SDK cannot represent before spawning', () => {
    expect(() =>
      prepareClaudeMcpServers(
        [
          {
            id: '__proto__',
            enabled: true,
            transport: { type: 'http', url: 'https://example.test' },
          },
        ],
        {},
      ),
    ).toThrow('Choose another id')
    expect(() =>
      prepareClaudeMcpServers(
        [0, 1].map(() => ({
          id: 'duplicate',
          enabled: true as const,
          transport: { type: 'http' as const, url: 'https://example.test' },
        })),
        {},
      ),
    ).toThrow('Duplicate MCP server id')
    expect(() =>
      prepareClaudeMcpServers(
        [
          {
            id: 'local',
            enabled: true,
            transport: { type: 'stdio', command: 'node', cwd: 'C:\\repo' },
          },
        ],
        {},
      ),
    ).toThrow('Remove it to use the project directory')
  })

  it('redacts split stderr and escaped error details without losing the tail', () => {
    const secret = `canary-${crypto.randomUUID()}-"quoted"`
    const redactor = new ClaudeMcpRedactor([secret])
    const input = `start ${secret} middle ${JSON.stringify(secret).slice(1, -1)} end ${encodeURIComponent(secret)} tail`
    const output = [...input].map((chunk) => redactor.push(chunk)).join('') + redactor.finish()
    expect(output).toBe('start [REDACTED] middle [REDACTED] end [REDACTED] tail')
    expect(output).not.toContain(secret)
    expect(redactor.finish()).toBe('')
  })

  it('rejects a known credential copied into argv instead of a credential field', () => {
    const secret = `canary-${crypto.randomUUID()}`
    expect(() =>
      prepareClaudeMcpServers(
        [
          {
            id: 'local',
            enabled: true,
            transport: {
              type: 'stdio',
              command: 'node',
              args: ['server.mjs', secret],
              environment: { TOKEN: { source: 'credential', credentialRef: 'token' } },
            },
          },
        ],
        { token: secret },
      ),
    ).toThrow('MCP credentials cannot appear in commands, arguments, or URLs')
  })

  it.each(['uri', 'form', 'lowercase'] as const)(
    'rejects a known credential in a %s encoded URL',
    (encoding) => {
      const secret = `canary-${crypto.randomUUID()}/value+with spaces`
      const query =
        encoding === 'form'
          ? new URLSearchParams({ token: secret }).toString()
          : `token=${encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (value) => (encoding === 'lowercase' ? value.toLowerCase() : value))}`
      expect(() =>
        prepareClaudeMcpServers(
          [
            {
              id: 'remote',
              enabled: true,
              transport: {
                type: 'http',
                url: `https://example.test/mcp?${query}`,
                headers: { Authorization: { source: 'credential', credentialRef: 'token' } },
              },
            },
          ],
          { token: secret },
        ),
      ).toThrow('MCP credentials cannot appear in commands, arguments, or URLs')
    },
  )
})
