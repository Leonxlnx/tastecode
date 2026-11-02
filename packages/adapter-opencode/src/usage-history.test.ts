import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_USAGE_HISTORY, readOpenCodeUsageHistory } from './usage-history.js'

describe('OpenCode usage history source', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the given data directory, then OPENCODE_DATA_DIR, then the XDG data home', () => {
    const account = path.join(os.tmpdir(), 'opencode-account')
    vi.stubEnv('OPENCODE_DATA_DIR', path.join(os.tmpdir(), 'opencode-data'))
    vi.stubEnv('XDG_DATA_HOME', path.join(os.tmpdir(), 'xdg'))
    expect(OPENCODE_USAGE_HISTORY.root(account)).toBe(account)
    expect(OPENCODE_USAGE_HISTORY.root()).toBe(path.join(os.tmpdir(), 'opencode-data'))

    vi.stubEnv('OPENCODE_DATA_DIR', undefined)
    expect(OPENCODE_USAGE_HISTORY.root()).toBe(path.join(os.tmpdir(), 'xdg', 'opencode'))

    vi.stubEnv('XDG_DATA_HOME', undefined)
    expect(OPENCODE_USAGE_HISTORY.root()).toBe(
      path.join(os.homedir(), '.local', 'share', 'opencode'),
    )
  })

  it('lists only OpenCode databases and folds the WAL into their fingerprint', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-opencode-data-'))
    try {
      writeFileSync(path.join(directory, 'opencode.db'), '')
      writeFileSync(path.join(directory, 'opencode.db-wal'), 'appended')
      writeFileSync(path.join(directory, 'opencode-dev.db'), 'db')
      writeFileSync(path.join(directory, 'other.db'), 'db')
      writeFileSync(path.join(directory, 'opencode.txt'), 'text')
      mkdirSync(path.join(directory, 'opencode-folder.db'))

      const archive = await OPENCODE_USAGE_HISTORY.discover(directory)
      expect(archive.available).toBe(true)
      expect(
        archive.files
          .map((file) => [path.basename(file.path), file.size, file.read])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ).toEqual([
        ['opencode-dev.db', 2, readOpenCodeUsageHistory],
        ['opencode.db', 8, readOpenCodeUsageHistory],
      ])
      await expect(
        OPENCODE_USAGE_HISTORY.discover(path.join(directory, 'missing')),
      ).rejects.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('OpenCode local usage history', () => {
  it('reads only assistant accounting fields and groups messages by session and model', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-opencode-usage-'))
    const file = path.join(directory, 'opencode.db')
    const database = new DatabaseSync(file)
    try {
      database.exec(
        `CREATE TABLE message (
           id TEXT PRIMARY KEY,
           session_id TEXT NOT NULL,
           time_created INTEGER NOT NULL,
           data TEXT NOT NULL
         )`,
      )
      const insert = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      insert.run('one', 'session-1', Date.parse('2026-08-08T12:00:00Z'), message(0.02))
      insert.run('two', 'session-1', Date.parse('2026-08-08T12:05:00Z'), message(0.03))
      insert.run(
        'user',
        'session-1',
        Date.parse('2026-08-08T12:06:00Z'),
        JSON.stringify({ role: 'user', content: 'never read by the scanner' }),
      )
    } finally {
      database.close()
    }

    try {
      await expect(readOpenCodeUsageHistory(file)).resolves.toEqual([
        {
          date: '2026-08-08',
          model: 'openrouter/model-1',
          sessionId: 'session-1',
          longContext: false,
          tokens: {
            uncachedInputTokens: 20,
            cachedInputTokens: 6,
            cacheWrite5mInputTokens: 4,
            cacheWrite1hInputTokens: 0,
            outputTokens: 14,
            reasoningTokens: 4,
            providerReportedCostUsd: 0.05,
          },
        },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function message(cost: number): string {
  return JSON.stringify({
    role: 'assistant',
    providerID: 'openrouter',
    modelID: 'model-1',
    cost,
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 2 } },
  })
}
