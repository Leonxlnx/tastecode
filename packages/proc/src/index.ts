import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { desktopPath } from './desktop-path.js'
import { killTree, ownProcessTree, ownedProcessSpawnOptions } from './kill.js'
import { parseJsonValue, type JsonRpcValue } from './jsonrpc.js'

export { applyDesktopPath, desktopPath } from './desktop-path.js'
export type { DesktopPathOptions } from './desktop-path.js'
export {
  cleanupExitedPtySession,
  killTree,
  ownProcessTree,
  ownPtySession,
  ownedProcessSpawnOptions,
  terminatePtySession,
  terminateTree,
  type TerminateTreeOptions,
} from './kill.js'

export {
  JsonRpcError,
  parseJsonValue,
  JsonRpcValueSchema,
  StdioJsonRpc,
  type JsonRpcId,
  type JsonRpcRequestOptions,
  type JsonRpcResultParser,
  type JsonRpcValue,
  type ParsedJsonRpcRequestOptions,
  type ServerRequestHandler,
  type StdioJsonRpcProcess,
} from './jsonrpc.js'

/**
 * Spawn a CLI that may have been installed as an npm shim.
 *
 * On Windows, `codex` is `codex.cmd` and `claude` is `claude.cmd` — batch
 * files. `spawn('codex')` fails with EINVAL because CreateProcess cannot
 * execute a .cmd directly; it has to go through cmd.exe. This is the single
 * most common way a cross-platform agent wrapper breaks on Windows, so every
 * adapter shares this one implementation rather than each rediscovering it.
 *
 * Arguments are passed as an array, so cmd.exe never sees an unquoted value.
 */
export function spawnCli(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; replaceEnv?: boolean } = {},
): ChildProcessWithoutNullStreams {
  const spawnOptions = {
    ...(!(options.cwd === undefined) ? { cwd: options.cwd } : {}),
    env: childEnvironment(options),
    stdio: ['pipe', 'pipe', 'pipe'] satisfies Array<'pipe'>,
    windowsHide: true,
    ...ownedProcessSpawnOptions(),
  }

  if (process.platform === 'win32') {
    if (/\.(?:exe|com)$/i.test(command)) {
      return ownProcessTree(spawn(command, args, spawnOptions))
    }
    return ownProcessTree(spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], spawnOptions))
  }
  return ownProcessTree(spawn(command, args, spawnOptions))
}

/**
 * Whether a command exists on PATH.
 *
 * Asked with the platform's own lookup rather than by running the thing: agent
 * CLIs open browsers, start sessions, and print banners on first launch, none
 * of which is an acceptable side effect of drawing a list.
 */
export function isInstalled(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const [lookup, args] =
    process.platform === 'win32' ? ['where.exe', [command]] : ['/usr/bin/which', [command]]

  return new Promise((resolve) => {
    const child = spawn(lookup, args, {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...environment, PATH: desktopPath(environment.PATH ?? '', { env: environment }) },
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

function childEnvironment(options: {
  env?: NodeJS.ProcessEnv
  replaceEnv?: boolean
}): NodeJS.ProcessEnv | undefined {
  if (options.replaceEnv) return options.env
  const env = { ...process.env, ...options.env }
  env.PATH = desktopPath(env.PATH ?? '', { env })
  return env
}

/**
 * A CLI's own version string, or undefined if it will not say.
 *
 * Every vendor formats this differently and some print startup noise first, so
 * this takes the first line that contains a version-looking number rather than
 * trusting position. Reporting nothing beats reporting a deprecation warning as
 * if it were a version.
 */
export function commandVersion(command: string, timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawnCli(command, ['--version'])
    let output = ''
    let settled = false

    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child)
      resolve(value)
    }

    const timer = setTimeout(() => finish(undefined), timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', () => finish(undefined))
    child.on('close', () => {
      const line = output.split('\n').find((entry) => /\d+\.\d+/.test(entry))
      finish(line?.trim() || undefined)
    })
  })
}

/** Run a short, non-interactive CLI command and capture its public output. */
export function runCli(
  command: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args)
    let stdout = ''
    let settled = false
    const finish = (result: { code: number | null; stdout: string } | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish(new Error(`${command} did not respond`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', finish)
    child.on('close', (code) => finish({ code, stdout }))
  })
}

/**
 * Read newline-delimited JSON from a stream.
 *
 * Chunks split mid-line constantly, so the partial tail has to survive between
 * reads — parsing per chunk instead of per line is the bug every one of these
 * starts with.
 */
export function readNdjson(
  stream: NodeJS.ReadableStream,
  onValue: (value: JsonRpcValue) => void,
  onUnparsable?: (line: string) => void,
): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      try {
        onValue(parseJsonValue(line))
      } catch {
        onUnparsable?.(line)
      }
    }
  })
  // A final line without a trailing newline would otherwise vanish when the
  // process exits — for CLIs whose last write is the result, deterministically.
  stream.on('end', () => {
    const line = buffer.trim()
    if (line === '') return
    try {
      onValue(parseJsonValue(line))
    } catch {
      onUnparsable?.(line)
    }
  })
}
