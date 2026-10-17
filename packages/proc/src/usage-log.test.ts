import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { readUsageLog, type UsageLogParser } from './usage-log.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Collects every line it is handed, so tests can compare the split itself. */
const collectLines: UsageLogParser<string, string[]> = {
  create: () => [],
  line: (lines, line) => {
    lines.push(line)
  },
  finish: (lines) => lines,
}

describe('usage log reading', () => {
  it('hands over the same lines as readline', async () => {
    const longLine = JSON.stringify({ text: 'ä€😀'.repeat(400_000) })
    const cases = {
      empty: '',
      trailingNewline: '{"a":1}\n{"b":2}\n',
      noTrailingNewline: '{"a":1}\n{"b":2}',
      crlf: '{"a":1}\r\n{"b":2}\r\n',
      blankLines: '\n{"a":1}\n\n\n{"b":2}\n',
      // Over two read chunks, with multi-byte characters across the chunk boundaries.
      spanningChunks: `${longLine}\n{"after":true}\n${longLine}`,
      partialLastLine: '{"a":1}\n{"b":',
    }
    for (const [name, content] of Object.entries(cases)) {
      const filePath = logFile(content)
      expect(await readUsageLog(filePath, collectLines), name).toEqual(
        await readlineLines(filePath),
      )
    }
  })

  it('gives the parser the file path and returns what finish makes of its state', async () => {
    const filePath = logFile('{"tokens":3}\nnot json\n{"tokens":4}\n')
    const parser: UsageLogParser<{ file: string; tokens: number }, { file: string; sum: number }> =
      {
        create: (file) => ({ file, sum: 0 }),
        line: (state, line) => {
          try {
            state.sum += (JSON.parse(line) as { tokens: number }).tokens
          } catch {
            // Not a record.
          }
        },
        finish: (state) => [{ file: state.file, tokens: state.sum }],
      }

    expect(await readUsageLog(filePath, parser)).toEqual([{ file: filePath, tokens: 7 }])
  })

  it('rejects a missing file', async () => {
    const missing = path.join(temporaryDirectory(), 'missing.jsonl')
    await expect(readUsageLog(missing, collectLines)).rejects.toThrow()
  })
})

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
