import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApiToolCall } from '@harness/adapter-api'
import type { JsonValue } from '@harness/contracts'
import { z } from 'zod'
import { createApiWorkspaceTools } from './api-workspace-tools.js'
import { commandRuntimeDirectory } from './safe-command-environment.js'

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-api-tools-'))
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const value = 1\n')
  writeFileSync(path.join(root, '.env'), 'TOKEN=never-read')
  return root
}

function call(name: string, input: JsonValue): ApiToolCall {
  return { id: `call-${name}`, name, input }
}

describe('direct API workspace tools', () => {
  it('reads with a hash and rejects stale writes', async () => {
    const root = workspace()
    const tools = createApiWorkspaceTools(root)
    const signal = new AbortController().signal
    const read = await tools.executeTool(call('read_file', { path: 'src/app.ts' }), signal)
    const result = z
      .object({ sha256: z.string(), content: z.string() })
      .parse(JSON.parse(read.content))
    expect(result.content).toContain('value = 1')

    await tools.executeTool(
      call('write_file', {
        path: 'src/app.ts',
        content: 'export const value = 2\n',
        expectedSha256: result.sha256,
      }),
      signal,
    )
    expect(readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toContain('value = 2')
    await expect(
      tools.executeTool(
        call('write_file', {
          path: 'src/app.ts',
          content: 'stale',
          expectedSha256: result.sha256,
        }),
        signal,
      ),
    ).rejects.toThrow('file changed since it was read')
  })

  it('omits credential files from directory listings', async () => {
    const tools = createApiWorkspaceTools(workspace())
    const signal = new AbortController().signal
    const listed = await tools.executeTool(call('list_files', { path: '.' }), signal)
    expect(listed.content).not.toContain('.env')
  })

  it('requires approval for mutation unless full access was explicit', () => {
    const root = workspace()
    const ask = createApiWorkspaceTools(root, 'auto')
    expect(ask.reviewTool(call('write_file', { path: 'src/app.ts' }))).toMatchObject({
      kind: 'file_change',
      path: path.join('src', 'app.ts'),
    })
    expect(createApiWorkspaceTools(root, 'full').reviewTool(call('write_file', {}))).toBeUndefined()
  })

  it('runs argv commands and rejects shell composition', async () => {
    const tools = createApiWorkspaceTools(workspace(), 'full')
    const signal = new AbortController().signal
    const result = await tools.executeTool(
      call('run_command', { command: 'node', args: ['--version'], cwd: '.' }),
      signal,
    )
    expect(result.isError).toBeUndefined()
    process.env['HARNESS_HIDDEN'] = 'server-secret'
    try {
      const environment = await tools.executeTool(
        call('run_command', {
          command: 'node',
          args: ['-p', 'process.env.HARNESS_HIDDEN'],
          cwd: '.',
        }),
        signal,
      )
      expect(environment.content).not.toContain('server-secret')
    } finally {
      delete process.env['HARNESS_HIDDEN']
    }
    await expect(
      tools.executeTool(
        call('run_command', { command: 'node', args: ['--version&&whoami'], cwd: '.' }),
        signal,
      ),
    ).rejects.toThrow('command argument is unsafe')
  })

  it('returns the environment refusal instead of a generic tool failure', async () => {
    if (process.platform === 'win32') return
    // Redirect os.tmpdir so the default runtime path lands in this scratch
    // directory, then squat it with a regular file to force the refusal.
    const parent = mkdtempSync(path.join(tmpdir(), 'harness-env-refusal-'))
    const savedTmpdir = process.env['TMPDIR']
    process.env['TMPDIR'] = parent
    try {
      writeFileSync(commandRuntimeDirectory(), 'squat')
      const tools = createApiWorkspaceTools(workspace(), 'full')
      const result = await tools.executeTool(
        call('run_command', { command: 'node', args: ['--version'], cwd: '.' }),
        new AbortController().signal,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('not a directory')
      expect(result.content).not.toBe('Tool execution failed.')
    } finally {
      if (savedTmpdir === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = savedTmpdir
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
