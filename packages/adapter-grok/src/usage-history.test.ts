import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalUsageRecord } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GROK_USAGE_HISTORY,
  readGrokSessionUsage,
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

  it('reads the given home, GROK_HOME or ~/.grok', () => {
    const account = path.join(os.tmpdir(), 'grok-account')
    expect(GROK_USAGE_HISTORY.root(account)).toBe(account)

    vi.stubEnv('GROK_HOME', path.join(os.tmpdir(), 'grok-home'))
    expect(GROK_USAGE_HISTORY.root()).toBe(path.join(os.tmpdir(), 'grok-home'))

    vi.stubEnv('GROK_HOME', undefined)
    expect(GROK_USAGE_HISTORY.root()).toBe(path.join(os.homedir(), '.grok'))
  })

  it('lists the log with the reader that continues from a checkpoint', async () => {
    const home = temporaryDirectory()
    mkdirSync(path.join(home, 'logs'))
    logFile(path.join(home, 'logs'), 'unified.jsonl', ['{}'])
    const archive = await GROK_USAGE_HISTORY.discover(home)
    expect(archive.files.map((entry) => [entry.read, entry.readFrom])).toEqual([
      [readGrokUsageHistory, resumeGrokUsageHistory],
    ])
  })

  it('lists the sessions’ usage files, and the log for the days before them', async () => {
    const home = temporaryDirectory()
    mkdirSync(path.join(home, 'logs'))
    const log = logFile(path.join(home, 'logs'), 'unified.jsonl', ['{}'])
    const first = sessionUsage(home, 'E%3A%5Csite', 'a1', { sessionId: 'a1', turns: [] })
    const second = sessionUsage(home, 'E%3A%5Cother', 'b2', { sessionId: 'b2', turns: [] })
    mkdirSync(path.join(home, 'sessions', 'E%3A%5Csite', 'never-written'))
    writeFileSync(path.join(home, 'sessions', 'session_search.sqlite'), 'x')

    const archive = await GROK_USAGE_HISTORY.discover(home)

    expect(archive.available).toBe(true)
    const sessions = archive.files.filter((entry) => entry.read === readGrokSessionUsage)
    expect(sessions.map((entry) => entry.path).sort()).toEqual([first, second].sort())
    const older = archive.files.filter((entry) => entry.read !== readGrokSessionUsage)
    expect(older.map((entry) => entry.path)).toEqual([`${log}#before-${today()}`])
    expect(older[0]!.readFrom).toBeUndefined()
  })

  it('keeps the log’s usage from before the first usage file, and not after', async () => {
    const home = temporaryDirectory()
    mkdirSync(path.join(home, 'logs'))
    logFile(path.join(home, 'logs'), 'unified.jsonl', [
      row('2026-08-07T12:00:00.000Z', 42, 'model catalog: notifying clients', {
        current_model_id: 'grok-4.5',
      }),
      row('2026-08-07T12:01:00.000Z', 42, 'shell.turn.inference_done', {
        prompt_tokens: 1_000,
        completion_tokens: 100,
      }),
      // A debug-level log goes on recording what the usage files hold too.
      row(new Date().toISOString(), 42, 'shell.turn.inference_done', {
        prompt_tokens: 500,
        completion_tokens: 50,
      }),
    ])
    sessionUsage(home, 'site', 'a1', {
      sessionId: 'a1',
      turns: [
        {
          endedAt: new Date().toISOString(),
          primaryModelId: 'grok-4.7',
          inputTokens: 500,
          outputTokens: 50,
        },
      ],
    })

    const archive = await GROK_USAGE_HISTORY.discover(home)
    const entries = (await Promise.all(archive.files.map((file) => file.read(file.path)))).flat()

    expect(entries.map((entry) => [entry.date, entry.tokens.uncachedInputTokens]).sort()).toEqual(
      [
        ['2026-08-07', 1_000],
        [today(), 500],
      ].sort(),
    )
  })

  it('has no archive in a home with neither', async () => {
    await expect(GROK_USAGE_HISTORY.discover(temporaryDirectory())).rejects.toThrow()
  })
})

describe('Grok session usage files', () => {
  it('reads a row per turn and model, with cached reads and reasoning inside the counts', async () => {
    const file = sessionUsage(temporaryDirectory(), 'E%3A%5Csite', 'folder-id', {
      sessionId: 'b238d114',
      updatedAt: '2026-11-04T08:00:00.000Z',
      session: { inputTokens: 999_999 },
      turns: [
        {
          turnNumber: 1,
          endedAt: '2026-11-04T07:30:00.000Z',
          primaryModelId: 'grok-4.7-build',
          inputTokens: 1_000,
          outputTokens: 300,
          modelUsage: {
            'grok-4.7-build': {
              inputTokens: 1_000,
              outputTokens: 300,
              cachedReadTokens: 600,
              reasoningTokens: 120,
              totalTokens: 1_300,
              modelCalls: 2,
            },
          },
        },
        {
          turnNumber: 2,
          endedAt: '2026-11-04T07:40:00.000Z',
          modelUsage: {
            'grok-4.7-build': { inputTokens: 500, outputTokens: 50, cachedReadTokens: 400 },
            'grok-4.7-build-fast': {
              inputTokens: 900_000,
              outputTokens: 10,
              modelCalls: 3,
            },
          },
        },
        { turnNumber: 3, endedAt: 'not a date', modelUsage: {} },
      ],
    })

    const day = localDay('2026-11-04T07:30:00.000Z')
    expect(summed(await readGrokSessionUsage(file))).toEqual({
      [`${day}|grok-4.7-build|b238d114|false`]: {
        uncachedInputTokens: 500,
        cachedInputTokens: 1_000,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 350,
        reasoningTokens: 120,
        providerReportedCostUsd: 0,
      },
      [`${day}|grok-4.7-build-fast|b238d114|true`]: {
        uncachedInputTokens: 900_000,
        cachedInputTokens: 0,
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
        providerReportedCostUsd: 0,
      },
    })
  })

  it('falls back to the primary model, and to the folder name for the session', async () => {
    const file = sessionUsage(temporaryDirectory(), 'E%3A%5Csite', 'c3', {
      turns: [
        {
          endedAt: '2026-11-05T10:00:00.000Z',
          primaryModelId: 'grok-4.6-build',
          inputTokens: 10,
          outputTokens: 5,
        },
      ],
    })

    expect(await readGrokSessionUsage(file)).toMatchObject([
      { model: 'grok-4.6-build', sessionId: 'c3', tokens: { uncachedInputTokens: 10 } },
    ])
  })

  it('reads a file caught mid-write as nothing yet', async () => {
    const file = sessionUsage(temporaryDirectory(), 'E%3A%5Csite', 'd4', {})
    writeFileSync(file, '{"sessionId":"d4","turns":[{"endedAt"')
    expect(await readGrokSessionUsage(file)).toEqual([])
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

/** A session's usage file in the CLI's store: `<home>/sessions/<folder>/<session>/usage.json`. */
function sessionUsage(home: string, folder: string, session: string, usage: unknown): string {
  const directory = path.join(home, 'sessions', folder, session)
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'usage.json')
  writeFileSync(file, JSON.stringify(usage))
  return file
}

/** The local calendar day the usage index files a moment under. */
function localDay(timestamp: string): string {
  const date = new Date(timestamp)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
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

/** Today's local calendar day, as the usage index names days. */
function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
