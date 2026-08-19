import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApiToolCall } from '@harness/adapter-api'
import type { JsonValue } from '@harness/contracts'
import { z } from 'zod'
import { createApiWorkspaceTools } from './api-workspace-tools.js'

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

const CREDENTIAL_PATHS = [
  ['.aws', 'credentials'],
  ['.ssh', 'config'],
  ['.gnupg', 'private-keys-v1.d', 'key'],
  ['.docker', 'config.json'],
  ['.kube', 'config'],
  ['.azure', 'accessTokens.json'],
  ['.config', 'gcloud', 'application_default_credentials.json'],
  ['.netrc'],
] as const

function addCredentialFiles(root: string): string[] {
  return CREDENTIAL_PATHS.map((components) => {
    const relative = path.join(...components)
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, 'private material')
    return relative
  })
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

  it('omits credential locations while preserving ordinary config listings', async () => {
    const root = workspace()
    addCredentialFiles(root)
    mkdirSync(path.join(root, '.config', 'editor'), { recursive: true })
    writeFileSync(path.join(root, '.config', 'editor', 'settings.json'), '{}')
    writeFileSync(path.join(root, 'config.json'), '{}')
    const tools = createApiWorkspaceTools(root)
    const signal = new AbortController().signal
    const listed = await tools.executeTool(call('list_files', { path: '.' }), signal)
    for (const name of ['.env', '.aws', '.ssh', '.gnupg', '.docker', '.kube', '.azure', '.netrc']) {
      expect(listed.content).not.toContain(name)
    }
    expect(listed.content).toContain('config.json')

    const config = await tools.executeTool(call('list_files', { path: '.config' }), signal)
    expect(config.content).not.toContain('gcloud')
    expect(config.content).toContain('editor')

    await expect(tools.executeTool(call('list_files', { path: '.aws' }), signal)).rejects.toThrow(
      'credential files are not available',
    )
    await expect(
      tools.executeTool(call('list_files', { path: path.join('.config', 'gcloud') }), signal),
    ).rejects.toThrow('credential files are not available')
  })

  it('rejects reads and writes anywhere below credential locations', async () => {
    const root = workspace()
    const restricted = addCredentialFiles(root)
    const tools = createApiWorkspaceTools(root, 'full')
    const signal = new AbortController().signal

    for (const relative of restricted) {
      await expect(
        tools.executeTool(call('read_file', { path: relative }), signal),
      ).rejects.toThrow('credential files are not available')
      await expect(
        tools.executeTool(
          call('write_file', {
            path: relative,
            content: 'replacement',
            expectedSha256: null,
          }),
          signal,
        ),
      ).rejects.toThrow('credential files are not available')
    }

    symlinkSync(path.join(root, '.aws'), path.join(root, 'credential-alias'), 'junction')
    await expect(
      tools.executeTool(call('read_file', { path: 'credential-alias/credentials' }), signal),
    ).rejects.toThrow('credential files are not available')
    await expect(
      tools.executeTool(
        call('write_file', {
          path: 'credential-alias/new-token',
          content: 'replacement',
          expectedSha256: null,
        }),
        signal,
      ),
    ).rejects.toThrow('credential files are not available')
  })

  it('requires approval for mutation unless full access was explicit', () => {
    const root = workspace()
    const ask = createApiWorkspaceTools(root, 'auto')
    expect(ask.reviewTool(call('write_file', { path: 'src/app.ts' }))).toMatchObject({
      kind: 'file_change',
      path: 'src/app.ts',
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
})
