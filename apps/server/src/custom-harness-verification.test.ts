import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CustomHarness } from '@harness/contracts'
import { verifyCustomHarness } from './adapters.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('custom harness verification', () => {
  it('completes a real ACP handshake with the configured cwd and environment', async () => {
    const launchDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-acp-mod-'))
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-acp-workspace-'))
    roots.push(launchDirectory, workspace)
    const server = path.join(launchDirectory, 'server.mjs')
    writeFileSync(
      server,
      [
        "import readline from 'node:readline'",
        'const lines = readline.createInterface({ input: process.stdin })',
        "lines.on('line', (line) => {",
        '  const request = JSON.parse(line)',
        "  if (request.method !== 'initialize') return",
        '  const contextMatches = process.cwd() === process.env.MOD_LAUNCH_DIR && process.env.HARNESS_WORKSPACE_PATH === process.env.EXPECTED_WORKSPACE',
        '  if (!contextMatches) process.exit(12)',
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentInfo: { name: 'Example ACP Mod', version: '3.2.1' } } }) + '\\n')",
        '})',
      ].join('\n'),
      'utf8',
    )
    const harness: CustomHarness = {
      id: 'example-acp-mod',
      displayName: 'Example ACP Mod',
      provider: 'acp',
      command: process.execPath,
      args: [server],
      workingDirectory: launchDirectory,
      environment: {
        MOD_LAUNCH_DIR: realpathSync(launchDirectory),
        EXPECTED_WORKSPACE: workspace,
      },
    }

    const result = await verifyCustomHarness(harness, workspace)

    expect(result).toMatchObject({
      status: 'ready',
      resolvedCommand: process.execPath,
      checks: [
        { label: 'Executable', status: 'passed' },
        { label: 'Launch context', status: 'passed' },
        { label: 'ACP', status: 'passed' },
      ],
    })
    expect(result.checks[2]?.detail).toContain('Example ACP Mod 3.2.1')
  })

  it('returns an actionable error for a shell-only alias', async () => {
    const result = await verifyCustomHarness({
      id: 'missing-mod',
      displayName: 'Missing Mod',
      provider: 'pi',
      command: 'this-is-only-a-shell-alias',
      args: [],
      environment: { PATH: '' },
    })

    expect(result.status).toBe('error')
    expect(result.checks[0]?.detail).toMatch(/Shell aliases and functions are unavailable/)
  })
})
