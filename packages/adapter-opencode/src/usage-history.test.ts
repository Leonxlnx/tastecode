import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { readOpenCodeUsageHistory } from './usage-history.js'

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
