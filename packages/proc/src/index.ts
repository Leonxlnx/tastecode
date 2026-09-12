import { parseJsonValue, type JsonRpcValue } from './jsonrpc.js'
import { LineBuffer } from './frames.js'
export { LineBuffer, MAX_PROTOCOL_FRAME_BYTES, ProtocolFrameError, readSseData } from './frames.js'

export { applyDesktopPath, desktopPath } from './desktop-path.js'
export type { DesktopPathOptions } from './desktop-path.js'
export { killTree, spawnOwned } from './kill.js'
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
  options: { maxFrameBytes?: number; onError?: (error: Error) => void } = {},
): void {
  const buffer = new LineBuffer(options.maxFrameBytes)
  let failed = false
  const onLine = (raw: string) => {
    const line = raw.trim()
    if (line === '') return
    try {
      onValue(parseJsonValue(line))
    } catch {
      onUnparsable?.(line)
    }
  }
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    if (failed) return
    try {
      buffer.write(chunk, onLine)
    } catch (error) {
      failed = true
      buffer.clear()
      const failure = error instanceof Error ? error : new Error('Provider stream failed')
      if (options.onError) options.onError(failure)
      else onUnparsable?.(failure.message)
    }
  })
  stream.on('end', () => {
    if (!failed) buffer.end(onLine)
  })
}
