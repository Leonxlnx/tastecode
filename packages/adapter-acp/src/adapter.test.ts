import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { acpPromptContent, parseAcpThreadId } from './adapter.js'
import { ACP_CAPABILITIES } from './capabilities.js'
import { prepareAcpMcpServers, validateAcpMcpServer } from './mcp.js'

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

  it('links files the agent did not negotiate as pixels, which every agent accepts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harness-acp-link-'))
    const image = join(directory, 'preview.png')
    const notes = join(directory, 'notes.pdf')
    try {
      writeFileSync(image, Buffer.from([1, 2, 3]))
      writeFileSync(notes, Buffer.from([1, 2, 3, 4]))
      expect(acpPromptContent('Review this page.', [image], false)).toEqual([
        { type: 'text', text: 'Review this page.' },
        {
          type: 'resource_link',
          name: 'preview.png',
          uri: pathToFileURL(image).href,
          size: 3,
          mimeType: 'image/png',
        },
      ])
      // A file that is not an image stays a link even when pixels were negotiated.
      expect(acpPromptContent('Read this.', [notes], true)[1]).toEqual({
        type: 'resource_link',
        name: 'notes.pdf',
        uri: pathToFileURL(notes).href,
        size: 4,
      })
      expect(() => acpPromptContent('Gone.', [join(directory, 'missing.png')], false)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('declares image files for every agent and pixels only after negotiation', () => {
    expect(ACP_CAPABILITIES).toMatchObject({ images: false, imageFiles: true })
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
    ).toThrow('cannot use a custom working directory through ACP')
  })

  it('rejects saves that an ACP launch cannot honor', () => {
    expect(() => validateAcpMcpServer({ id: 'inherited', enabled: false })).toThrow(
      'cannot be hidden through ACP',
    )
    expect(() =>
      validateAcpMcpServer({
        id: 'cwd-tools',
        enabled: true,
        transport: { type: 'stdio', command: 'node', cwd: '/tmp/tools' },
      }),
    ).toThrow('cannot use a custom working directory through ACP')
    expect(() =>
      validateAcpMcpServer({
        id: 'remote-tools',
        enabled: true,
        transport: { type: 'http', url: 'https://mcp.example.test' },
      }),
    ).not.toThrow()
  })
})
