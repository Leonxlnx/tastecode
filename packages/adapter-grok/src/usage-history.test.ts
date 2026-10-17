import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalUsageRecord } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GROK_USAGE_HISTORY,
  readGrokUsageHistory,
  resumeGrokUsageHistory,
} from './usage-history.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Grok usage history source', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads the unified log of the given home, GROK_HOME or ~/.grok', () => {
    const account = path.join(os.tmpdir(), 'grok-account')
    expect(GROK_USAGE_HISTORY.root(account)).toBe(path.join(account, 'logs', 'unified.jsonl'))

    vi.stubEnv('GROK_HOME', path.join(os.tmpdir(), 'grok-home'))
    expect(GROK_USAGE_HISTORY.root()).toBe(
      path.join(os.tmpdir(), 'grok-home', 'logs', 'unified.jsonl'),
    )

    vi.stubEnv('GROK_HOME', undefined)
    expect(GROK_USAGE_HISTORY.root()).toBe(
      path.join(os.homedir(), '.grok', 'logs', 'unified.jsonl'),
    )
  })

  it('lists the log with the reader that continues from a checkpoint', async () => {
    const file = logFile(temporaryDirectory(), 'unified.jsonl', ['{}'])
    const archive = await GROK_USAGE_HISTORY.discover(file)
    expect(archive.files.map((entry) => [entry.read, entry.readFrom])).toEqual([
      [readGrokUsageHistory, resumeGrokUsageHistory],
    ])
  })
})

describe('Grok local usage history', () => {
  it('attributes token rows to each process model and preserves cache and reasoning', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-grok-usage-'))
    const file = path.join(directory, 'unified.jsonl')
    try {
      writeFileSync(
        file,
        [
          row('2026-08-08T12:00:00.000Z', 42, 'model catalog: notifying clients', {
            current_model_id: 'grok-4.5',
          }),
          row('2026-08-08T12:01:00.000Z', 42, 'shell.turn.inference_done', {
            prompt_tokens: 1_000,
            cached_prompt_tokens: 600,
            completion_tokens: 100,
            reasoning_tokens: 25,
          }),
          row('2026-08-08T12:02:00.000Z', 42, 'shell.turn.inference_done', {
            prompt_tokens: 500,
            cached_prompt_tokens: 100,
            completion_tokens: 50,
            reasoning_tokens: 5,
          }),
          row('2026-08-08T12:03:00.000Z', 99, 'shell.turn.inference_done', {
            prompt_tokens: 20,
            completion_tokens: 2,
          }),
        ].join('\n'),
      )

      await expect(readGrokUsageHistory(file)).resolves.toEqual([
        {
          date: '2026-08-08',
          model: 'grok-4.5',
          sessionId: 'grok-process-42',
          longContext: false,
          tokens: {
            uncachedInputTokens: 800,
            cachedInputTokens: 700,
            cacheWrite5mInputTokens: 0,
            cacheWrite1hInputTokens: 0,
            outputTokens: 180,
            reasoningTokens: 30,
            providerReportedCostUsd: 0,
          },
        },
        expect.objectContaining({
          model: 'Unknown model',
          sessionId: 'grok-process-99',
          tokens: expect.objectContaining({ uncachedInputTokens: 20, outputTokens: 2 }),
        }),
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('continued Grok usage history', () => {
  const log = [
    row('2026-08-08T12:00:00.000Z', 42, 'agent initialized', {}),
    row('2026-08-08T12:00:01.000Z', 42, 'model catalog: notifying clients', {
      current_model_id: 'grok-4.5',
    }),
    row('2026-08-08T12:01:00.000Z', 42, 'shell.turn.inference_done', {
      prompt_tokens: 1_000,
      cached_prompt_tokens: 600,
      completion_tokens: 100,
      reasoning_tokens: 25,
    }),
    row('2026-08-08T12:01:30.000Z', 7, 'AuthManager::new', {}),
    row('2026-08-08T12:02:00.000Z', 42, 'model changed', { model: 'grok-4.7-build' }),
    row('2026-08-08T12:03:00.000Z', 42, 'shell.turn.inference_done', {
      prompt_tokens: 250_000,
      completion_tokens: 50,
    }),
    // The pid is reused by a new process, which starts a new session.
    row('2026-08-09T12:00:00.000Z', 42, 'agent initialized', {}),
    row('2026-08-09T12:01:00.000Z', 42, 'shell.turn.inference_done', {
      prompt_tokens: 20,
      completion_tokens: 2,
    }),
  ]

  it('adds up to a full read wherever the log was cut', async () => {
    const directory = temporaryDirectory()
    const full = await readGrokUsageHistory(logFile(directory, 'full.jsonl', log))
    for (let cut = 1; cut < log.length; cut += 1) {
      const file = logFile(directory, `cut-${cut}.jsonl`, log.slice(0, cut))
      const first = await resumeGrokUsageHistory(file)
      appendFileSync(file, lines(log.slice(cut)))
      const second = await resumeGrokUsageHistory(file, first.checkpoint)
      expect(second.appended, `cut after line ${cut}`).toBe(true)
      expect(summed([...first.entries, ...second.entries]), `cut after line ${cut}`).toEqual(
        summed(full),
      )
    }
  })

  it('reads a rotated or trimmed log in full, keeping only the token rows it still holds', async () => {
    const directory = temporaryDirectory()
    const file = logFile(directory, 'unified.jsonl', log)
    const { checkpoint } = await resumeGrokUsageHistory(file)

    // Rotated: a new log that already grew past the old checkpoint.
    const rotated = [
      row('2026-08-10T08:00:00.000Z', 51, 'agent initialized', {}),
      ...Array.from({ length: 40 }, (_value, index) =>
        row('2026-08-10T08:00:01.000Z', 51, 'startup timing', { step: index }),
      ),
      row('2026-08-10T08:01:00.000Z', 51, 'shell.turn.inference_done', {
        prompt_tokens: 30,
        completion_tokens: 3,
      }),
    ]
    writeFileSync(file, lines(rotated))
    const afterRotation = await resumeGrokUsageHistory(file, checkpoint)
    expect(afterRotation.appended).toBe(false)
    expect(afterRotation.entries).toEqual([
      expect.objectContaining({ sessionId: expect.stringMatching(/^grok-process-51-/) }),
    ])

    // Trimmed: the oldest lines are cut away, so the log shrank.
    writeFileSync(file, lines(log.slice(6)))
    const afterTrim = await resumeGrokUsageHistory(file, afterRotation.checkpoint)
    expect(afterTrim.appended).toBe(false)
    expect(summed(afterTrim.entries)).toEqual(summed(await readGrokUsageHistory(file)))
  })
})

function logFile(directory: string, name: string, rows: string[]): string {
  const file = path.join(directory, name)
  writeFileSync(file, lines(rows))
  return file
}

function lines(rows: string[]): string {
  return rows.map((line) => `${line}\n`).join('')
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
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-grok-usage-'))
  temporaryDirectories.push(directory)
  return directory
}

function row(
  timestamp: string,
  processId: number,
  message: string,
  context: Record<string, unknown>,
): string {
  return JSON.stringify({ ts: timestamp, pid: processId, msg: message, ctx: context })
}
