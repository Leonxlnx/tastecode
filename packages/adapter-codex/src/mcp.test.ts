import { describe, expect, it } from 'vitest'
import { methods, type McpStartupStatus } from '@harness/contracts'
import type { ListMcpServerStatusResponse } from './generated/v2/ListMcpServerStatusResponse.js'
import type { McpServerStatusUpdatedNotification } from './generated/v2/McpServerStatusUpdatedNotification.js'
import {
  CODEX_MCP_CAPABILITIES,
  mapMcpServerStatus,
  mapMcpStartupStatus,
  prepareMcpConfig,
} from './mcp.js'

/** Sanitized frames captured from Codex 0.146.0 against two process-local test servers. */
const response: ListMcpServerStatusResponse = {
  data: [
    {
      name: 'broken',
      serverInfo: null,
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    },
    {
      name: 'capture',
      serverInfo: {
        name: 'captured-server',
        title: 'Captured server',
        version: '1.2.3',
        description: 'Captured from a real Codex app-server exchange',
        icons: null,
        websiteUrl: null,
      },
      tools: {
        captured_tool: {
          name: 'captured_tool',
          title: 'Captured tool',
          description: 'A captured tool',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          outputSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
          },
        },
      },
      resources: [
        {
          uri: 'capture://resource',
          name: 'captured-resource',
          title: 'Captured resource',
          description: 'A captured resource',
          mimeType: 'text/plain',
          size: 7,
        },
      ],
      resourceTemplates: [
        {
          uriTemplate: 'capture://resource/{id}',
          name: 'captured-template',
          title: 'Captured template',
          description: 'A captured resource template',
          mimeType: 'text/plain',
        },
      ],
      authStatus: 'unsupported',
    },
  ],
  nextCursor: null,
}

const startupFrames: McpServerStatusUpdatedNotification[] = [
  {
    threadId: 'captured-thread',
    name: 'broken',
    status: 'failed',
    error: 'MCP startup failed: program not found',
    failureReason: null,
  },
  {
    threadId: 'captured-thread',
    name: 'capture',
    status: 'ready',
    error: null,
    failureReason: null,
  },
]

describe('Codex MCP inventory', () => {
  it('maps captured tools, resources and startup failures into the shared contract', () => {
    const startup = new Map<string, McpStartupStatus>(
      startupFrames.map((frame) => [frame.name, mapMcpStartupStatus(frame)]),
    )
    const result = {
      capabilities: CODEX_MCP_CAPABILITIES,
      servers: response.data.map((server) => mapMcpServerStatus(server, startup.get(server.name))),
    }

    expect(methods['mcp.list'].result.parse(result)).toEqual(result)
    expect(result.servers[0]).toMatchObject({
      id: 'broken',
      startup: { state: 'failed', message: 'MCP startup failed: program not found' },
    })
    expect(result.servers[1]).toMatchObject({
      displayName: 'Captured server',
      auth: { status: 'not_required' },
      startup: { state: 'ready' },
      tools: [{ name: 'captured_tool' }],
      resources: [{ uri: 'capture://resource' }],
      resourceTemplates: [{ uriTemplate: 'capture://resource/{id}' }],
    })
  })

  it('passes credential references through the app-server environment, not JSON config', () => {
    const result = prepareMcpConfig(
      [
        {
          id: 'docs',
          enabled: true,
          transport: {
            type: 'http',
            url: 'https://example.com/mcp',
            headers: {
              Authorization: { source: 'credential', credentialRef: 'mcp/docs/auth' },
            },
          },
        },
      ],
      { 'mcp/docs/auth': 'Bearer secret-value' },
    )

    expect(result.servers['docs']).toMatchObject({
      url: 'https://example.com/mcp',
      env_http_headers: { Authorization: expect.stringMatching(/^HARNESS_MCP_/) },
    })
    expect(Object.values(result.environment)).toEqual(['Bearer secret-value'])
    expect(JSON.stringify(result.servers)).not.toContain('secret-value')
  })

  it.each([
    ['notLoggedIn', { status: 'sign_in_required', method: 'oauth' }],
    ['bearerToken', { status: 'authenticated', method: 'bearer' }],
    ['oAuth', { status: 'authenticated', method: 'oauth' }],
  ] as const)('maps Codex auth status %s', (authStatus, expected) => {
    expect(mapMcpServerStatus({ ...response.data[0]!, authStatus }).auth).toEqual(expected)
  })
})
