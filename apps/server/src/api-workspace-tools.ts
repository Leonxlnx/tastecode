import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { ApiTool, ApiToolCall, ApiToolResult } from '@harness/adapter-api'
import type { ApprovalMode, ApprovalRequest } from '@harness/contracts'
import { spawnCli } from '@harness/proc'
import {
  assertPublicWorkspaceFile,
  existingWorkspacePath,
  isSecretWorkspaceName,
  writableWorkspacePath,
} from './api-workspace-paths.js'
import { safeCommandEnvironment } from './safe-command-environment.js'

const MAX_READ_BYTES = 200_000
const MAX_WRITE_BYTES = 1_000_000
const MAX_OUTPUT_BYTES = 100_000
const COMMANDS = new Set(['bun', 'git', 'node', 'npm', 'npx', 'pnpm', 'yarn'])
const UNSAFE_ARG = /[&|<>^%!"\r\n()]/

export const API_WORKSPACE_TOOLS: ApiTool[] = [
  {
    name: 'list_files',
    description: 'List one directory inside the active workspace. Secret files are omitted.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative directory.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace and return its SHA-256 hash.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Write a UTF-8 workspace file. Supply the hash returned by read_file, or null for a new file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        expectedSha256: { type: ['string', 'null'] },
      },
      required: ['path', 'content', 'expectedSha256'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description:
      'Run an approved non-interactive project command without a shell expression. Supported executables: bun, git, node, npm, npx, pnpm, yarn.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
      },
      required: ['command', 'args', 'cwd'],
      additionalProperties: false,
    },
  },
]

export function createApiWorkspaceTools(workspacePath: string, approval: ApprovalMode = 'ask') {
  const workspace = realpathSync(workspacePath)

  return {
    tools: API_WORKSPACE_TOOLS,
    executeTool: (call: ApiToolCall, signal: AbortSignal) =>
      executeWorkspaceTool(workspace, call, signal),
    reviewTool: (call: ApiToolCall): Omit<ApprovalRequest, 'id' | 'createdAt'> | undefined => {
      if (approval === 'full') return undefined
      const input = record(call.input, `${call.name} input`)
      if (call.name === 'write_file') {
        return {
          kind: 'file_change',
          path: displayPath(input.path),
          reason: 'Modify a project file',
        }
      }
      if (call.name === 'run_command') {
        return {
          kind: 'command',
          command: commandLine(input),
          cwd: displayPath(input.cwd),
          reason: 'Run a project command',
        }
      }
      return undefined
    },
  }
}

async function executeWorkspaceTool(
  workspace: string,
  call: ApiToolCall,
  signal: AbortSignal,
): Promise<ApiToolResult> {
  const input = record(call.input, `${call.name} input`)
  switch (call.name) {
    case 'list_files': {
      const directory = existingWorkspacePath(workspace, string(input.path, 'workspace path'), true)
      const entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !isSecretWorkspaceName(entry.name))
        .slice(0, 500)
        .map((entry) => `${entry.isDirectory() ? 'directory' : 'file'}\t${entry.name}`)
      return { content: entries.join('\n') || '(empty directory)' }
    }
    case 'read_file': {
      const file = existingWorkspacePath(workspace, string(input.path, 'workspace path'), false)
      assertPublicWorkspaceFile(file)
      if (statSync(file).size > MAX_READ_BYTES) throw new Error('file exceeds the read limit')
      const content = readFileSync(file, 'utf8')
      return {
        content: JSON.stringify({
          path: displayPath(input.path),
          sha256: sha256(content),
          content,
        }),
      }
    }
    case 'write_file': {
      const destination = writableWorkspacePath(workspace, string(input.path, 'workspace path'))
      assertPublicWorkspaceFile(destination)
      const content = text(input.content, 'write_file content')
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES)
        throw new Error('file exceeds the write limit')
      const expected = nullableString(input.expectedSha256, 'write_file expectedSha256')
      const current = existsSync(destination) ? readFileSync(destination, 'utf8') : undefined
      if ((current === undefined ? null : sha256(current)) !== expected) {
        throw new Error('file changed since it was read')
      }
      mkdirSync(path.dirname(destination), { recursive: true })
      const temporary = `${destination}.${randomUUID()}.tmp`
      const backup = `${destination}.${randomUUID()}.bak`
      writeFileSync(temporary, content, 'utf8')
      let backedUp = false
      try {
        if (existsSync(destination)) {
          renameSync(destination, backup)
          backedUp = true
        }
        renameSync(temporary, destination)
      } catch (error) {
        if (backedUp && !existsSync(destination)) renameSync(backup, destination)
        throw error
      } finally {
        removeTemporary(temporary)
        if (existsSync(destination)) removeTemporary(backup)
      }
      return { content: JSON.stringify({ path: displayPath(input.path), sha256: sha256(content) }) }
    }
    case 'run_command':
      return runCommand(workspace, input, signal)
    default:
      return { content: `Unknown tool: ${call.name}`, isError: true }
  }
}

function removeTemporary(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    // A stale temp is recoverable; the destination has already been preserved.
  }
}

function runCommand(
  workspace: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ApiToolResult> {
  const command = string(input.command, 'run_command command')
  if (!COMMANDS.has(command)) throw new Error('command is not in the project-tool allowlist')
  const args = strings(input.args, 'run_command args')
  if (args.some((arg) => UNSAFE_ARG.test(arg))) throw new Error('command argument is unsafe')
  const cwd = existingWorkspacePath(workspace, string(input.cwd, 'workspace path'), true)

  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args, {
      cwd,
      replaceEnv: true,
      env: safeCommandEnvironment(workspace),
    })
    let output = ''
    let settled = false
    const finish = (result: ApiToolResult | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      result instanceof Error ? reject(result) : resolve(result)
    }
    const append = (chunk: string) => {
      output = `${output}${chunk}`.slice(-MAX_OUTPUT_BYTES)
    }
    const abort = () => {
      child.kill()
      finish(new DOMException('interrupted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('command exceeded the 120 second limit'))
    }, 120_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', finish)
    child.on('exit', (code) =>
      finish({
        content: JSON.stringify({ code, output }),
        ...(code === 0 ? {} : { isError: true }),
      }),
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdin.end()
  })
}

function commandLine(input: Record<string, unknown>): string {
  return [
    string(input.command, 'run_command command'),
    ...strings(input.args, 'run_command args'),
  ].join(' ')
}

function displayPath(value: unknown): string {
  return typeof value === 'string' && value ? value : '.'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${field} must be a string`)
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  return string(value, field)
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a string array`)
  }
  return value
}
