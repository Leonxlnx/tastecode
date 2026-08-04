import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export { JsonRpcError, StdioJsonRpc, type JsonRpcId, type ServerRequestHandler } from './jsonrpc.js'

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
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcessWithoutNullStreams {
  const spawnOptions = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'] satisfies Array<'pipe'>,
    windowsHide: true,
  }

  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], spawnOptions)
  }
  return spawn(command, args, spawnOptions)
}

/**
 * Whether a command exists on PATH.
 *
 * Asked with the platform's own lookup rather than by running the thing: agent
 * CLIs open browsers, start sessions, and print banners on first launch, none
 * of which is an acceptable side effect of drawing a list.
 */
export function isInstalled(command: string): Promise<boolean> {
  const [lookup, args] =
    process.platform === 'win32' ? ['where.exe', [command]] : ['/usr/bin/which', [command]]

  return new Promise((resolve) => {
    const child = spawn(lookup, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
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
      child.kill()
      resolve(value)
    }

    const timer = setTimeout(() => finish(undefined), timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', () => finish(undefined))
    child.on('exit', () => {
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
      result instanceof Error ? reject(result) : resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`${command} did not respond`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', finish)
    child.on('exit', (code) => finish({ code, stdout }))
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
  onValue: (value: unknown) => void,
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
        onValue(JSON.parse(line))
      } catch {
        onUnparsable?.(line)
      }
    }
  })
}
