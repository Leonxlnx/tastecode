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
