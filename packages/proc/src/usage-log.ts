import { open, type FileHandle } from 'node:fs/promises'

const READ_CHUNK_BYTES = 1024 * 1024
const NEWLINE = 0x0a

/**
 * An adapter's parser for one JSONL log. `line` sees every line in file order;
 * `finish` turns what the lines left in the state into usage entries.
 */
export type UsageLogParser<Entry, State> = {
  create(filePath: string): State
  line(state: State, line: string): void
  finish(state: State): Entry[]
}

/** Parses a JSONL log line by line in one streaming pass. */
export async function readUsageLog<Entry, State>(
  filePath: string,
  parser: UsageLogParser<Entry, State>,
): Promise<Entry[]> {
  const state = parser.create(filePath)
  const handle = await open(filePath, 'r')
  try {
    const { tail } = await forEachLine(handle, 0, (line) => parser.line(state, line))
    if (tail !== undefined) parser.line(state, tail)
  } finally {
    await handle.close()
  }
  return parser.finish(state)
}

/**
 * Hands every newline-terminated line from byte `start` to `onLine`, without
 * its line break (`\n` or `\r\n`). Returns the byte offset just past the last
 * line break and the text after it, if the file does not end with one.
 */
async function forEachLine(
  handle: FileHandle,
  start: number,
  onLine: (line: string) => void,
): Promise<{ end: number; tail: string | undefined }> {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  /** Pieces of a line that spans chunks; copied, because `chunk` is reused. */
  let carry: Buffer[] = []
  let position = start
  let end = start
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
    if (bytesRead === 0) break
    const view = chunk.subarray(0, bytesRead)
    let from = 0
    let newline = view.indexOf(NEWLINE)
    while (newline !== -1) {
      let bytes = view.subarray(from, newline)
      if (carry.length > 0) {
        carry.push(bytes)
        bytes = Buffer.concat(carry)
        carry = []
      }
      onLine(decodeLine(bytes))
      from = newline + 1
      end = position + from
      newline = view.indexOf(NEWLINE, from)
    }
    if (from < bytesRead) carry.push(Buffer.from(view.subarray(from)))
    position += bytesRead
  }
  return { end, tail: carry.length > 0 ? decodeLine(Buffer.concat(carry)) : undefined }
}

function decodeLine(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  return text.endsWith('\r') ? text.slice(0, -1) : text
}
