import { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { McpServerConfig } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { CursorAdapter } from './adapter.js'
import { validateCursorMcpServer } from './mcp.js'

class FakeChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdin = new PassThrough()
  override stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ]
  override kill(): boolean {
    setImmediate(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('exit', 0, null)
      this.emit('close', 0)
    })
    return true
  }
}

describe('Cursor managed MCP plugin', () => {
  it('rejects project hide overrides', () => {
    expect(() =>
      validateCursorMcpServer({ id: 'docs', enabled: false } as McpServerConfig),
    ).toThrow('cannot be hidden through Cursor')
  })

  it('passes --plugin-dir and --approve-mcps with credentials only in env and cleans up on dispose', async () => {
    const secret = 'Bearer cursor-secret-token'
    const stdioSecret = 'stdio-api-key-secret'
    const servers: McpServerConfig[] = [
      {
        id: 'tastecode',
        enabled: true,
        transport: {
          type: 'http',
          url: 'http://127.0.0.1:4123/agents/xyz',
          headers: { Authorization: { source: 'credential', credentialRef: 'tc' } },
        },
      },
      {
        id: 'local',
        enabled: true,
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['my-mcp'],
          environment: {
            MODE: { source: 'literal', value: 'test' },
            API_KEY: { source: 'credential', credentialRef: 'api' },
          },
        },
      },
    ]

    let capturedArgs: string[] = []
    let capturedEnv: Record<string, string | undefined> | undefined
    const child = new FakeChild()
    const adapter = new CursorAdapter({
      spawn: ((_cmd: string, args: string[], options?: { env?: Record<string, string> }) => {
        capturedArgs = args
        capturedEnv = options?.env
        return child
      }) as never,
      mcpServers: servers,
      mcpCredentials: { tc: secret, api: stdioSecret },
    })

    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'hello')

    const pluginIdx = capturedArgs.indexOf('--plugin-dir')
    expect(pluginIdx).toBeGreaterThan(-1)
    expect(capturedArgs).toContain('--approve-mcps')
    expect(capturedArgs.join(' ')).not.toContain(secret)
    expect(capturedArgs.join(' ')).not.toContain(stdioSecret)

    const pluginDir = capturedArgs[pluginIdx + 1]!
    expect(existsSync(path.join(pluginDir, '.cursor-plugin', 'plugin.json'))).toBe(true)
    const mcpJsonText = readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8')
    expect(mcpJsonText).not.toContain(secret)
    expect(mcpJsonText).not.toContain(stdioSecret)

    const parsed = JSON.parse(mcpJsonText) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    }
    expect(parsed.mcpServers['tastecode']?.command).toBe(process.execPath)
    expect(parsed.mcpServers['local']).toEqual({
      command: 'npx',
      args: ['my-mcp'],
      env: { MODE: 'test' },
    })

    expect(capturedEnv?.['API_KEY']).toBe(stdioSecret)
    expect(Object.values(capturedEnv ?? {})).toEqual(
      expect.arrayContaining([
        '1',
        'http://127.0.0.1:4123/agents/xyz',
        JSON.stringify({ Authorization: secret }),
      ]),
    )

    await adapter.dispose()
    expect(existsSync(pluginDir)).toBe(false)
  })
})
