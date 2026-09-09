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

export type ClaudeUsageQueryRuntime = Pick<
  Query,
  'close' | 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
>

export type ClaudeUsageQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => ClaudeUsageQueryRuntime

export type ClaudeSpawn = typeof spawnCli

export const createClaudeQuery: ClaudeQueryFactory = (input) => query(input)
export const createClaudeUsageQuery: ClaudeUsageQueryFactory = (input) => query(input)

/**
 * Let the Agent SDK own its protocol while TasteCode owns process creation.
 * `spawnCli` is the cross-platform boundary for npm `.cmd` launchers, and a
 * custom harness can replace it without losing its fixed arguments or env.
 */
export function claudeSdkSpawner(
  spawn: ClaudeSpawn = spawnCli,
  onStderr?: (chunk: string) => void,
  onStop?: (stopped: Promise<void>) => void,
  onSpawn?: (child: ReturnType<ClaudeSpawn>) => void,
) {
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      replaceEnv: true,
    })
    onSpawn?.(child)

    const stop = () => {
      const stopped = killTree(child)
      onStop?.(stopped)
      return stopped
    }
    const abort = () => {
      void stop()
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => onStderr?.(chunk))
    child.stderr.resume()
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
    child.once('exit', () => options.signal.removeEventListener('abort', abort))
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return child.killed
      },
      get exitCode() {
        return child.exitCode
      },
      get signalCode() {
        return child.signalCode
      },
      kill: () => {
        void stop()
        return true
      },
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child),
    }
  }
}

// oxlint-disable-next-line require-yield -- This prompt intentionally stays empty until abort.
export async function* waitForAbort(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  )
}
