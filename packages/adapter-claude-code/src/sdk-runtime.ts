import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { killTree, spawnCli } from '@harness/proc'
import { propertiesWhen } from './properties-when.js'

export type ClaudeQueryRuntime = Pick<
  Query,
  | 'close'
  | 'initializationResult'
  | 'interrupt'
  | 'setModel'
  | 'setPermissionMode'
  | 'supportedModels'
  | 'toggleMcpServer'
> &
  AsyncIterable<SDKMessage>

export type ClaudeQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => ClaudeQueryRuntime

export type ClaudeSpawn = typeof spawnCli

export const createClaudeQuery: ClaudeQueryFactory = (input) => query(input)

/**
 * Let the Agent SDK own its protocol while TasteCode owns process creation.
 * `spawnCli` is the cross-platform boundary for npm `.cmd` launchers, and a
 * custom harness can replace it without losing its fixed arguments or env.
 */
export function claudeSdkSpawner(
  spawn: ClaudeSpawn = spawnCli,
  onStderr?: (chunk: string) => void,
) {
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      ...propertiesWhen(options.cwd, (includedValue) => ({ cwd: includedValue })),
      env: options.env,
      replaceEnv: true,
    })

    const abort = () => killTree(child)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => onStderr?.(chunk))
    child.stderr.resume()
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
    child.once('exit', () => options.signal.removeEventListener('abort', abort))
    return child
  }
}

export async function* waitForAbort(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  )
}
