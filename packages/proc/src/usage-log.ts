import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'

const READ_CHUNK_BYTES = 1024 * 1024
const NEWLINE = 0x0a
/** How many bytes at the start of a log, and just before a checkpoint, must be unchanged to resume. */
const FINGERPRINT_BYTES = 4096

/**
 * Where a parse of an append-only log stopped: just past its last complete
 * line. The hashes cover the log's first bytes and the bytes just before that
 * point, so a log that was rewritten, truncated or rotated since is read again
 * from its start instead of from the offset.
 */
export type UsageLogPosition = { offset: number; head: string; tail: string }

/** A parse that can continue where it stopped. `state` is the adapter parser's own. */
export type UsageCheckpoint = { position: UsageLogPosition; state: unknown }

export type UsageLogRead<Entry> = {
  entries: Entry[]
  /** True when `entries` hold only what the lines after the given checkpoint add. */
  appended: boolean
  /** Absent when the next read has to start over, for example after an unterminated last line. */
  checkpoint?: UsageCheckpoint
}

/**
 * An adapter's parser for one JSONL log. `line` sees every line in file order;
 * `finish` turns what the lines left in the state into usage entries.
 */
export type UsageLogParser<Entry, State> = {
  create(filePath: string): State
  /** Restores a state `finish` saved; undefined when it is not one this parser can use. */
  restore(saved: unknown, filePath: string): State | undefined
  line(state: State, line: string): void
  /**
   * The entries the parsed lines add, and the state to save for the next read.
   * `saved` is absent while later lines could still withdraw entries returned
   * now; the next read then starts over. After a restore, returning undefined
   * means the new lines cannot be added to what was counted before, and the
   * whole log is read again.
   */
  finish(state: State): { entries: Entry[]; saved?: unknown } | undefined
}

/**
 * Parses a JSONL log line by line in one streaming pass. With a checkpoint
 * from an earlier read it parses only the lines appended since, as long as
 * the log still starts and continues the way it did then.
 */
export async function readUsageLog<Entry, State>(
  filePath: string,
  parser: UsageLogParser<Entry, State>,
  checkpoint?: UsageCheckpoint,
): Promise<UsageLogRead<Entry>> {
  const handle = await open(filePath, 'r')
  try {
    if (isUsageCheckpoint(checkpoint)) {
      const resumed = await resume(handle, filePath, parser, checkpoint)
      if (resumed) return resumed
    }
    const parsed = await parse(handle, parser, parser.create(filePath), 0)
    if (!parsed) throw new Error('A usage log parser rejected a read from the start of the log.')
    return { ...parsed, appended: false }
  } finally {
    await handle.close()
  }
}

export function isUsageCheckpoint(value: unknown): value is UsageCheckpoint {
  if (typeof value !== 'object' || value === null || !('state' in value)) return false
  const position = (value as { position?: Partial<UsageLogPosition> }).position
  return (
    typeof position === 'object' &&
    position !== null &&
    Number.isSafeInteger(position.offset) &&
    (position.offset ?? 0) > 0 &&
    typeof position.head === 'string' &&
    typeof position.tail === 'string'
  )
}

async function resume<Entry, State>(
  handle: FileHandle,
  filePath: string,
  parser: UsageLogParser<Entry, State>,
  checkpoint: UsageCheckpoint,
): Promise<UsageLogRead<Entry> | undefined> {
  const { offset } = checkpoint.position
  const { size } = await handle.stat()
  if (size < offset) return undefined
  const current = await positionAt(handle, offset)
  if (current.head !== checkpoint.position.head || current.tail !== checkpoint.position.tail) {
    return undefined
  }
  const state = parser.restore(checkpoint.state, filePath)
  if (state === undefined) return undefined
  if (size === offset) return { entries: [], appended: true, checkpoint }
  const parsed = await parse(handle, parser, state, offset)
  return parsed && { ...parsed, appended: true }
}

async function parse<Entry, State>(
  handle: FileHandle,
  parser: UsageLogParser<Entry, State>,
  state: State,
  start: number,
): Promise<Omit<UsageLogRead<Entry>, 'appended'> | undefined> {
  const { end, tail } = await forEachLine(handle, start, (line) => parser.line(state, line))
  // A last line without its newline is usually still being written. Parsed
  // only once it is complete JSON; the checkpoint then cannot sit after it.
  const completeTail = tail !== undefined && isCompleteJson(tail)
  if (completeTail) parser.line(state, tail)
  const finished = parser.finish(state)
  if (!finished) return undefined
  if (completeTail || finished.saved === undefined || end === 0) {
    return { entries: finished.entries }
  }
  return {
    entries: finished.entries,
    checkpoint: { position: await positionAt(handle, end), state: finished.saved },
  }
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

async function positionAt(handle: FileHandle, offset: number): Promise<UsageLogPosition> {
  const tailStart = Math.max(offset - FINGERPRINT_BYTES, 0)
  return {
    offset,
    head: await hashBytes(handle, 0, Math.min(offset, FINGERPRINT_BYTES)),
    tail: await hashBytes(handle, tailStart, offset - tailStart),
  }
}

async function hashBytes(handle: FileHandle, start: number, length: number): Promise<string> {
  const bytes = Buffer.alloc(length)
  const { bytesRead } = await handle.read(bytes, 0, length, start)
  return createHash('sha1').update(bytes.subarray(0, bytesRead)).digest('base64')
}

function decodeLine(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
