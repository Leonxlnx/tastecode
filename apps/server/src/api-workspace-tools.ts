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
import { killTree, spawnCli } from '@harness/proc'
import { z } from 'zod'
import {
  assertPublicWorkspaceFile,
  existingWorkspacePath,
  isSecretWorkspaceName,
  writableWorkspacePath,
} from './api-workspace-paths.js'
import { safeCommandEnvironment } from './safe-command-environment.js'
import { propertiesWhen } from './properties-when.js'

const MAX_READ_BYTES = 200_000
const MAX_WRITE_BYTES = 1_000_000
const MAX_OUTPUT_BYTES = 100_000
const COMMANDS = new Set(['bun', 'git', 'node', 'npm', 'npx', 'pnpm', 'yarn'])
const UNSAFE_ARG = /[&|<>^%!"\r\n()]/
const WorkspacePathInputSchema = z.object({ path: z.string().min(1) })
const WriteFileReviewInputSchema = z.object({ path: z.string().min(1) })
const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedSha256: z.string().min(1).nullable(),
})
const RunCommandInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
})
type RunCommandInput = z.infer<typeof RunCommandInputSchema>

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
  let currentApproval = approval

  return {
    tools: API_WORKSPACE_TOOLS,
    executeTool: (call: ApiToolCall, signal: AbortSignal) =>
      executeWorkspaceTool(workspace, call, signal),
    reviewTool: (call: ApiToolCall): Omit<ApprovalRequest, 'id' | 'createdAt'> | undefined => {
      if (currentApproval === 'full') return undefined
      if (call.name === 'write_file') {
        const input = WriteFileReviewInputSchema.parse(call.input)
        return {
          kind: 'file_change',
          path: displayPath(input.path),
          reason: 'Modify a project file',
        }
      }
      if (call.name === 'run_command') {
        const input = RunCommandInputSchema.parse(call.input)
        return {
          kind: 'command',
          command: commandLine(input),
          cwd: displayPath(input.cwd),
          reason: 'Run a project command',
        }
      }
      return undefined
    },
    /** Live access-level change for the running direct-API session. */
    setApproval(next: ApprovalMode): void {
      currentApproval = next
    },
  }
}

async function executeWorkspaceTool(
  workspace: string,
  call: ApiToolCall,
  signal: AbortSignal,
): Promise<ApiToolResult> {
  switch (call.name) {
    case 'list_files': {
      const input = WorkspacePathInputSchema.parse(call.input)
      const directory = existingWorkspacePath(workspace, input.path, true)
      const entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !isSecretWorkspaceName(entry.name))
        .slice(0, 500)
        .map((entry) => `${entry.isDirectory() ? 'directory' : 'file'}\t${entry.name}`)
      return { content: entries.join('\n') || '(empty directory)' }
    }
    case 'read_file': {
      const input = WorkspacePathInputSchema.parse(call.input)
      const file = existingWorkspacePath(workspace, input.path, false)
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
      const input = WriteFileInputSchema.parse(call.input)
      const destination = writableWorkspacePath(workspace, input.path)
      assertPublicWorkspaceFile(destination)
      const content = input.content
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES)
        throw new Error('file exceeds the write limit')
      const expected = input.expectedSha256
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
      return runCommand(workspace, RunCommandInputSchema.parse(call.input), signal)
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
  input: RunCommandInput,
  signal: AbortSignal,
): Promise<ApiToolResult> {
  const command = input.command
  if (!COMMANDS.has(command)) throw new Error('command is not in the project-tool allowlist')
  const args = input.args
  if (args.some((arg) => UNSAFE_ARG.test(arg))) throw new Error('command argument is unsafe')
  const cwd = existingWorkspacePath(workspace, input.cwd, true)

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
    // killTree, not kill: on Windows spawnCli runs through a cmd.exe shim, so
    // kill() ends the shim and leaves the real npm/node running — holding
    // locks in the worktree that later break its removal.
    const abort = () => {
      killTree(child)
      finish(new DOMException('interrupted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      killTree(child)
      // Keep what the command printed. A timeout is exactly the case where
      // the agent most needs the output to work out what hung.
      finish({
        content: JSON.stringify({
          code: null,
          output,
          error: 'command exceeded the 120 second limit',
        }),
        isError: true,
      })
    }, 120_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', finish)
    child.on('exit', (code) =>
      finish({
        content: JSON.stringify({ code, output }),
        ...propertiesWhen(!(code === 0), () => ({ isError: true })),
      }),
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdin.end()
  })
}

function commandLine(input: RunCommandInput): string {
  return [input.command, ...input.args].join(' ')
}

function displayPath(value: string): string {
  return value || '.'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
