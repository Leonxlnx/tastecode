import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { acpPromptContent, parseAcpThreadId, prepareAcpMcpServers } from './adapter.js'
import {
  LISTED_AGENTS,
  acpAccount,
  acpSignOut,
  discoverAgentModels,
  findAgentSpec,
  parseKimiModels,
} from './agents.js'

describe('ACP persisted sessions', () => {
  it('keeps provider-native session ids intact', () => {
    expect(parseAcpThreadId('acp-kimi-session_abc-123', 'kimi')).toBe('session_abc-123')
    expect(() => parseAcpThreadId('acp-gemini-session_abc', 'kimi')).toThrow('does not belong')
  })

  it('records the Kimi wire version verified by the real binary', () => {
    expect(findAgentSpec('kimi')).toMatchObject({
      command: 'kimi',
      args: ['acp'],
      verified: true,
      supportedVersion: '0.29',
    })
  })

  it('hides retired agents from listings but keeps them resumable', () => {
    // Gemini CLI is superseded by Antigravity; old threads must still resume.
    expect(LISTED_AGENTS.some((agent) => agent.id === 'gemini')).toBe(false)
    expect(LISTED_AGENTS.some((agent) => agent.id === 'qwen')).toBe(false)
    expect(findAgentSpec('gemini')).toMatchObject({ command: 'gemini', retired: true })
  })

  it('reports Kimi signed in only once the login left its credential file', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-home-'))
    try {
      expect(acpAccount('kimi', home)).toEqual({ signedIn: false })
      mkdirSync(join(home, '.kimi-code', 'credentials'), { recursive: true })
      writeFileSync(join(home, '.kimi-code', 'credentials', 'kimi-code.json'), '{}')
      expect(acpAccount('kimi', home)).toEqual({ signedIn: true })
      // No probe declared for Qwen: state is unknown, reported signed-out so
      // the sign-in flow stays reachable.
      expect(acpAccount('qwen', home)).toEqual({ signedIn: false })
      // Sign-out deletes exactly the file the login left, and nothing else.
      acpSignOut('kimi', home)
      expect(acpAccount('kimi', home)).toEqual({ signedIn: false })
      expect(() => acpSignOut('qwen', home)).toThrow('does not support')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
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

describe('ACP model discovery', () => {
  it('offers the concrete Gemini model names the CLI accepts', async () => {
    expect(await discoverAgentModels('gemini')).toMatchObject([
      { id: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro (Preview)', isDefault: true },
      { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (Preview)' },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite' },
    ])
  })

  it('normalizes the models reported by Kimi itself', () => {
    expect(
      parseKimiModels(
        JSON.stringify({
          models: {
            'kimi-code/k3': {
              displayName: 'Kimi K3',
              supportEfforts: ['low', 'high'],
              defaultEffort: 'high',
            },
          },
        }),
      ),
    ).toEqual([
      {
        id: 'kimi-code/k3',
        displayName: 'Kimi K3',
        isDefault: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
      },
    ])
  })
})
