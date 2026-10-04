import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readGrokUsageHistory } from './usage-history.js'

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

function row(
  timestamp: string,
  processId: number,
  message: string,
  context: Record<string, unknown>,
): string {
  return JSON.stringify({ ts: timestamp, pid: processId, msg: message, ctx: context })
}
