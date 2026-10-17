import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalUsageRecord } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_USAGE_HISTORY,
  readClaudeUsageHistory,
  resumeClaudeUsageHistory,
} from './usage-history.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Claude Code usage history source', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads transcripts from the projects folder of the given home or CLAUDE_CONFIG_DIR', () => {
    const account = path.join(os.tmpdir(), 'claude-account')
    expect(CLAUDE_USAGE_HISTORY.root(account)).toBe(path.join(account, 'projects'))

    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(os.tmpdir(), 'claude-config'))
    expect(CLAUDE_USAGE_HISTORY.root()).toBe(path.join(os.tmpdir(), 'claude-config', 'projects'))

    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
    expect(CLAUDE_USAGE_HISTORY.root()).toBe(path.join(os.homedir(), '.claude', 'projects'))
  })

  it('lists every session transcript below the projects folder', async () => {
    const directory = temporaryDirectory()
    mkdirSync(path.join(directory, 'project'))
    writeFileSync(path.join(directory, 'project', 'session.jsonl'), '{}\n')

    const archive = await CLAUDE_USAGE_HISTORY.discover(directory)
    expect(archive.available).toBe(true)
    expect(
      archive.files.map((file) => [path.basename(file.path), file.read, file.readFrom]),
    ).toEqual([['session.jsonl', readClaudeUsageHistory, resumeClaudeUsageHistory]])
  })
})

describe('continued Claude Code usage history', () => {
  const day = '2026-08-08T10:00:00.000Z'
  const nextDay = '2026-08-09T10:00:00.000Z'
  const transcript = [
    { type: 'user', timestamp: day, message: { role: 'user', content: 'hello' } },
    // One message written as three content blocks; the usage grows.
    snapshot({ id: 'a', input: 100, output: 10 }),
    snapshot({ id: 'a', input: 100, output: 40 }),
    snapshot({ id: 'a', input: 100, cached: 20, output: 90 }),
    { type: 'user', timestamp: day, message: { role: 'user', content: 'tool result' } },
    snapshot({ id: 'b', input: 5, cached: 3_000, output: 7 }),
    // The model is only known from the second snapshot.
    snapshot({ id: 'c', model: undefined, input: 50, output: 5 }),
    snapshot({ id: 'c', input: 50, output: 9 }),
    // The second snapshot lands on the next day, which moves the whole message.
    snapshot({ id: 'd', input: 60, output: 6 }),
    snapshot({ id: 'd', timestamp: nextDay, input: 60, output: 8 }),
    snapshot({ id: 'e', input: 300_000, output: 1, cost: 0.25 }),
    snapshot({ id: 'e', input: 300_000, output: 3, cost: 0.5 }),
    snapshot({ id: 'f', input: 0, output: 0 }),
    snapshot({ id: 'f', input: 8, output: 2 }),
  ]

  it('adds up to a full read wherever the transcript was cut', async () => {
    const full = await readClaudeUsageHistory(transcriptFile(transcript))
    const startedOver: number[] = []
    for (let cut = 1; cut < transcript.length; cut += 1) {
      const filePath = transcriptFile(transcript.slice(0, cut))
      const first = await resumeClaudeUsageHistory(filePath)
      expect(first.checkpoint, `cut after line ${cut}`).toBeDefined()
      appendFileSync(filePath, jsonLines(transcript.slice(cut)))
      const second = await resumeClaudeUsageHistory(filePath, first.checkpoint)
      const combined = second.appended ? [...first.entries, ...second.entries] : second.entries
      expect(summed(combined), `cut after line ${cut}`).toEqual(summed(full))
      if (!second.appended) startedOver.push(cut)
    }
    // Only cuts between snapshots that move a counted message to another
    // model or day make the next read start over.
    expect(startedOver).toEqual([7, 9])
  })

  it('remembers enough recent messages for a snapshot repeated a few messages later', async () => {
    const records = [
      snapshot({ id: 'early', input: 100, output: 10 }),
      ...Array.from({ length: 7 }, (_value, index) =>
        snapshot({ id: `between-${index}`, input: 1, output: 1 }),
      ),
      snapshot({ id: 'early', input: 100, output: 30 }),
    ]
    const filePath = transcriptFile(records.slice(0, -1))
    const first = await resumeClaudeUsageHistory(filePath)
    appendFileSync(filePath, jsonLines(records.slice(-1)))
    const second = await resumeClaudeUsageHistory(filePath, first.checkpoint)
    expect(second.appended).toBe(true)
    expect(second.entries).toEqual([
      expect.objectContaining({ tokens: expect.objectContaining({ outputTokens: 20 }) }),
    ])
    expect(summed([...first.entries, ...second.entries])).toEqual(
      summed(await readClaudeUsageHistory(filePath)),
    )
  })

  it('reads the whole transcript again when its saved state is not one it wrote', async () => {
    const filePath = transcriptFile(transcript.slice(0, 3))
    const { checkpoint } = await resumeClaudeUsageHistory(filePath)
    appendFileSync(filePath, jsonLines(transcript.slice(3)))
    for (const state of [{ version: 99 }, { version: 1, recent: [['a', 'not a record']] }]) {
      const again = await resumeClaudeUsageHistory(filePath, checkpoint && { ...checkpoint, state })
      expect(again.appended).toBe(false)
      expect(summed(again.entries)).toEqual(summed(await readClaudeUsageHistory(filePath)))
    }
  })
})

function snapshot(options: {
  id: string
  model?: string | undefined
  timestamp?: string
  input: number
  cached?: number
  output: number
  cost?: number
}) {
  return {
    type: 'assistant',
    uuid: `${options.id}-${options.output}`,
    timestamp: options.timestamp ?? '2026-08-08T10:00:00.000Z',
    sessionId: 'session',
    ...(options.cost === undefined ? {} : { costUSD: options.cost }),
    message: {
      id: options.id,
      ...('model' in options ? {} : { model: 'claude-opus-5-5' }),
      ...(options.model ? { model: options.model } : {}),
      usage: {
        input_tokens: options.input,
        cache_read_input_tokens: options.cached ?? 0,
        output_tokens: options.output,
      },
    },
  }
}

function transcriptFile(records: unknown[]): string {
  const filePath = path.join(temporaryDirectory(), 'session.jsonl')
  writeFileSync(filePath, jsonLines(records))
  return filePath
}

function jsonLines(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('')
}

/** Token totals per day, model, session and long-context flag, the way the usage index merges them. */
function summed(entries: readonly LocalUsageRecord[]) {
  const totals = new Map<string, Map<string, number>>()
  for (const entry of entries) {
    const key = [entry.date, entry.model, entry.sessionId, entry.longContext].join('|')
    let sums = totals.get(key)
    if (!sums) {
      sums = new Map()
      totals.set(key, sums)
    }
    for (const [field, value] of Object.entries(entry.tokens)) {
      if (typeof value === 'number') sums.set(field, (sums.get(field) ?? 0) + value)
    }
  }
  return Object.fromEntries([...totals].map(([key, sums]) => [key, Object.fromEntries(sums)]))
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-claude-usage-'))
  temporaryDirectories.push(directory)
  return directory
}
