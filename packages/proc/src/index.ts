import { parseJsonValue, type JsonRpcValue } from './jsonrpc.js'

export { applyDesktopPath, desktopPath } from './desktop-path.js'
export type { DesktopPathOptions } from './desktop-path.js'
export {
  cleanupExitedPtySession,
  killTree,
  OWNED_PROCESS_SHUTDOWN_MESSAGE,
  ownProcessTree,
  ownPtySession,
  ownedProcessSpawnOptions,
  terminatePtySession,
  terminateTree,
  type TerminateTreeOptions,
} from './kill.js'
export { commandVersion, isInstalled, runCli, spawnCli } from './cli.js'

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
