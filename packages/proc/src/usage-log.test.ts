import {
  appendFileSync,
  createReadStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { isUsageCheckpoint, readUsageLog, type UsageLogParser } from './usage-log.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Collects every line it is handed, so tests can compare the split itself. */
const collectLines: UsageLogParser<string, string[]> = {
  create: () => [],
  restore: () => [],
  line: (lines, line) => {
    lines.push(line)
  },
  finish: (lines) => ({ entries: lines, saved: 'lines' }),
}

/** Returns the `n` of every line it parsed since its state was created or restored. */
function counter(
  options: {
    restore?: (saved: unknown) => number[] | undefined
    finish?: (numbers: number[]) => { entries: number[]; saved?: unknown } | undefined
  } = {},
): UsageLogParser<number, number[]> {
  return {
    create: () => [],
    restore: options.restore ?? ((saved) => (saved === 'counter' ? [] : undefined)),
    line: (numbers, line) => {
      try {
        numbers.push((JSON.parse(line) as { n: number }).n)
      } catch {
        // Not a record.
      }
    },
    finish: options.finish ?? ((numbers) => ({ entries: numbers, saved: 'counter' })),
  }
}

describe('usage log reading', () => {
  it('hands over the same lines as readline, except an incomplete last line', async () => {
    const longLine = JSON.stringify({ text: 'ä€😀'.repeat(400_000) })
    const cases = {
      empty: '',
      trailingNewline: '{"a":1}\n{"b":2}\n',
      noTrailingNewline: '{"a":1}\n{"b":2}',
      crlf: '{"a":1}\r\n{"b":2}\r\n',
      blankLines: '\n{"a":1}\n\n\n{"b":2}\n',
      // Over two read chunks, with multi-byte characters across the chunk boundaries.
      spanningChunks: `${longLine}\n{"after":true}\n${longLine}`,
    }
    for (const [name, content] of Object.entries(cases)) {
      const filePath = logFile(content)
      expect((await readUsageLog(filePath, collectLines)).entries, name).toEqual(
        await readlineLines(filePath),
      )
    }

    // readline also hands over a half-written last line; no parser can use it.
    const partial = logFile('{"a":1}\n{"b":')
    expect(await readlineLines(partial)).toEqual(['{"a":1}', '{"b":'])
    expect((await readUsageLog(partial, collectLines)).entries).toEqual(['{"a":1}'])
  })

  it('gives the parser the file path and returns what finish makes of its state', async () => {
    const filePath = logFile('{"tokens":3}\nnot json\n{"tokens":4}\n')
    const parser: UsageLogParser<{ file: string; tokens: number }, { file: string; sum: number }> =
      {
        create: (file) => ({ file, sum: 0 }),
        restore: () => undefined,
        line: (state, line) => {
          try {
            state.sum += (JSON.parse(line) as { tokens: number }).tokens
          } catch {
            // Not a record.
          }
        },
        finish: (state) => ({ entries: [{ file: state.file, tokens: state.sum }] }),
      }

    expect(await readUsageLog(filePath, parser)).toEqual({
      entries: [{ file: filePath, tokens: 7 }],
      appended: false,
    })
  })

  it('reads only the lines appended after a checkpoint', async () => {
    const filePath = logFile(records(1, 2, 3))
    const first = await readUsageLog(filePath, counter())
    expect(first).toMatchObject({ entries: [1, 2, 3], appended: false })
    expect(first.checkpoint?.position.offset).toBe(statSync(filePath).size)
    expect(first.checkpoint?.state).toBe('counter')

    appendFileSync(filePath, records(4, 5))
    const second = await readUsageLog(filePath, counter(), first.checkpoint)
    expect(second).toMatchObject({ entries: [4, 5], appended: true })
    expect(second.checkpoint?.position.offset).toBe(statSync(filePath).size)

    appendFileSync(filePath, records(6))
    const third = await readUsageLog(filePath, counter(), second.checkpoint)
    expect(third).toMatchObject({ entries: [6], appended: true })
  })

  it('leaves a half-written last line to the next read', async () => {
    const filePath = logFile(`${records(1, 2)}{"n":`)
    const first = await readUsageLog(filePath, counter())
    expect(first.entries).toEqual([1, 2])
    expect(first.checkpoint?.position.offset).toBe(Buffer.byteLength(records(1, 2)))

    appendFileSync(filePath, `3}\n${records(4)}`)
    expect(await readUsageLog(filePath, counter(), first.checkpoint)).toMatchObject({
      entries: [3, 4],
      appended: true,
    })
  })

  it('parses a complete last line without its newline but cannot continue after it', async () => {
    const filePath = logFile(`${records(1)}{"n":2}`)
    const read = await readUsageLog(filePath, counter())
    expect(read.entries).toEqual([1, 2])
    expect(read.checkpoint).toBeUndefined()
  })

  it('returns nothing new when the log did not grow', async () => {
    const filePath = logFile(records(1, 2))
    const first = await readUsageLog(filePath, counter())
    const again = await readUsageLog(filePath, counter(), first.checkpoint)
    expect(again).toEqual({ entries: [], appended: true, checkpoint: first.checkpoint })
  })

  it('reads a truncated, rewritten or rotated log again from its start', async () => {
    const filler = (from: number) =>
      records(...Array.from({ length: 1_000 }, (_value, index) => from + index))
    const original = `${filler(0)}${records(-1)}`
    expect(Buffer.byteLength(original)).toBeGreaterThan(8 * 1024)
    const filePath = logFile(original)
    const { checkpoint } = await readUsageLog(filePath, counter())

    // Shorter than the checkpoint offset.
    writeFileSync(filePath, records(7, 8))
    expect(await readUsageLog(filePath, counter(), checkpoint)).toMatchObject({
      entries: [7, 8],
      appended: false,
    })

    // Longer, but its first bytes differ (a new log after rotation).
    writeFileSync(filePath, `${records(9)}${original}${records(10)}`)
    const rotated = await readUsageLog(filePath, counter(), checkpoint)
    expect(rotated.appended).toBe(false)
    expect(rotated.entries.at(0)).toBe(9)

    // Same start, but the bytes just before the checkpoint changed (rewritten in place).
    writeFileSync(filePath, `${filler(0)}${records(-2)}${records(11)}`)
    const rewritten = await readUsageLog(filePath, counter(), checkpoint)
    expect(rewritten.appended).toBe(false)
    expect(rewritten.entries.slice(-2)).toEqual([-2, 11])
  })

  it('starts over when the parser cannot use or continue its saved state', async () => {
    const filePath = logFile(records(1))
    const { checkpoint } = await readUsageLog(filePath, counter())
    appendFileSync(filePath, records(2))

    const unusable = counter({ restore: () => undefined })
    expect(await readUsageLog(filePath, unusable, checkpoint)).toMatchObject({
      entries: [1, 2],
      appended: false,
    })

    // A parser that cannot add the new lines to what it counted before makes
    // the read start over.
    type Counted = { numbers: number[]; restored: boolean }
    const withdrawing: UsageLogParser<number, Counted> = {
      create: () => ({ numbers: [], restored: false }),
      restore: () => ({ numbers: [], restored: true }),
      line: (state, line) => {
        state.numbers.push((JSON.parse(line) as { n: number }).n)
      },
      finish: (state) =>
        state.restored ? undefined : { entries: state.numbers, saved: 'counter' },
    }
    expect(await readUsageLog(filePath, withdrawing, checkpoint)).toMatchObject({
      entries: [1, 2],
      appended: false,
      checkpoint: { state: 'counter' },
    })

    // Entries a later line could still withdraw leave no checkpoint.
    const provisional = counter({ finish: (numbers) => ({ entries: numbers }) })
    expect((await readUsageLog(filePath, provisional)).checkpoint).toBeUndefined()
  })

  it('accepts only well-formed checkpoints', async () => {
    const filePath = logFile(records(1))
    const { checkpoint } = await readUsageLog(filePath, counter())
    expect(isUsageCheckpoint(checkpoint)).toBe(true)
    expect(isUsageCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toBe(true)
    for (const damaged of [
      undefined,
      null,
      'checkpoint',
      { position: checkpoint?.position },
      { state: 'counter', position: { ...checkpoint?.position, offset: -1 } },
      { state: 'counter', position: { ...checkpoint?.position, head: 1 } },
    ]) {
      expect(isUsageCheckpoint(damaged)).toBe(false)
    }
    // A damaged checkpoint is ignored: the log is read from its start.
    appendFileSync(filePath, records(2))
    expect(await readUsageLog(filePath, counter(), { state: 'counter' } as never)).toMatchObject({
      entries: [1, 2],
      appended: false,
    })
    expect(readFileSync(filePath, 'utf8')).toBe(records(1, 2))
  })

  it('rejects a missing file', async () => {
    const missing = path.join(temporaryDirectory(), 'missing.jsonl')
    await expect(readUsageLog(missing, collectLines)).rejects.toThrow()
  })
})

function records(...numbers: number[]): string {
  return numbers.map((n) => `${JSON.stringify({ n })}\n`).join('')
}

async function readlineLines(filePath: string): Promise<string[]> {
  const lines: string[] = []
  const reader = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) lines.push(line)
  return lines
}

function logFile(content: string): string {
  const filePath = path.join(temporaryDirectory(), 'log.jsonl')
  writeFileSync(filePath, content)
  return filePath
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-usage-log-'))
  temporaryDirectories.push(directory)
  return directory
}
