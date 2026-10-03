import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { acpPromptContent, parseAcpThreadId, prepareAcpMcpServers } from './adapter.js'

describe('ACP persisted sessions', () => {
  it('keeps provider-native session ids intact', () => {
    expect(parseAcpThreadId('acp-grok-session_abc-123', 'grok')).toBe('session_abc-123')
    expect(() => parseAcpThreadId('acp-other-session_abc', 'grok')).toThrow('does not belong')
  })
})

describe('ACP image prompts', () => {
  it('encodes negotiated images in the official content block shape', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harness-acp-image-'))
    const image = join(directory, 'preview.png')
    try {
      writeFileSync(image, Buffer.from([1, 2, 3]))
      expect(acpPromptContent('Review this page.', [image], true)).toEqual([
        { type: 'text', text: 'Review this page.' },
        {
          type: 'image',
          data: 'AQID',
          mimeType: 'image/png',
          uri: pathToFileURL(image).href,
        },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when the ACP agent did not negotiate image input', () => {
    expect(() => acpPromptContent('Review this page.', ['preview.png'], false)).toThrow(
      'does not support images',
    )
  })
})

describe('ACP MCP configuration', () => {
  it('maps enabled stdio and HTTP servers without exposing credential references', () => {
    expect(
      prepareAcpMcpServers(
        [
          { id: 'disabled', enabled: false },
          {
            id: 'local-tools',
            enabled: true,
            transport: {
              type: 'stdio',
              command: 'node',
              args: ['server.js'],
              environment: {
                MODE: { source: 'literal', value: 'test' },
                TOKEN: { source: 'credential', credentialRef: 'mcp/local/token' },
              },
            },
          },
          {
            id: 'remote-tools',
            enabled: true,
            transport: {
              type: 'http',
              url: 'https://mcp.example.test',
              headers: {
                Authorization: {
                  source: 'credential',
                  credentialRef: 'mcp/remote/auth',
                },
              },
            },
          },
        ],
        {
          'mcp/local/token': 'local-secret',
          'mcp/remote/auth': 'Bearer remote-secret',
        },
      ),
    ).toEqual([
      {
        name: 'local-tools',
        command: 'node',
        args: ['server.js'],
        env: [
          { name: 'MODE', value: 'test' },
          { name: 'TOKEN', value: 'local-secret' },
        ],
      },
      {
        type: 'http',
        name: 'remote-tools',
        url: 'https://mcp.example.test',
        headers: [{ name: 'Authorization', value: 'Bearer remote-secret' }],
      },
    ])
  })

  it('fails closed for unavailable credentials and unsupported custom working directories', () => {
    expect(() =>
      prepareAcpMcpServers(
        [
          {
            id: 'secret-tools',
            enabled: true,
            transport: {
              type: 'stdio',
              command: 'node',
              environment: {
                TOKEN: { source: 'credential', credentialRef: 'missing' },
              },
            },
          },
        ],
        {},
      ),
    ).toThrow('MCP credential "missing" is unavailable')

    expect(() =>
      prepareAcpMcpServers(
        [
          {
            id: 'cwd-tools',
            enabled: true,
            transport: { type: 'stdio', command: 'node', cwd: '/tmp/tools' },
          },
        ],
        {},
      ),
    ).toThrow('cannot use a custom cwd through ACP')
  })
})
