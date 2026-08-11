import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodexUsageHistory } from './usage-history.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('Codex usage history', () => {
  it('matches CodexProfilePro cumulative and cache token accounting', async () => {
    const filePath = await usageFile([
      tokenCount('2026-06-02T10:01:00.000Z', {
        input_tokens: 1_000,
        cached_input_tokens: 400,
        cache_write_tokens: 200,
        output_tokens: 100,
        reasoning_output_tokens: 20,
        total_tokens: 1_100,
      }),
      tokenCount('2026-06-02T10:02:00.000Z', {
        input_tokens: 1_800,
        cached_input_tokens: 500,
        cache_write_tokens: 300,
        output_tokens: 180,
        reasoning_output_tokens: 40,
        total_tokens: 1_980,
      }),
    ])

    const [usage] = await readCodexUsageHistory(filePath)
    expect(usage?.tokens).toEqual({
      observedInputTokens: 1_800,
      uncachedInputTokens: 1_000,
      cachedInputTokens: 500,
      cacheWrite5mInputTokens: 300,
      cacheWrite1hInputTokens: 0,
      outputTokens: 180,
      reasoningTokens: 40,
      processedTokens: 1_980,
      providerReportedCostUsd: 0,
    })
  })

  it('uses nested cache details and last usage after a cumulative rollback', async () => {
    const filePath = await usageFile([
      tokenCount('2026-06-02T10:01:00.000Z', {
        input_tokens: 1_000,
        output_tokens: 100,
        total_tokens: 1_100,
        input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
      }),
      tokenCount(
        '2026-06-02T10:02:00.000Z',
        {
          input_tokens: 300,
          output_tokens: 30,
          total_tokens: 330,
        },
        {
          input_tokens: 300,
          cache_read_input_tokens: 100,
          cache_write_input_tokens: 50,
          output_tokens: 30,
          total_tokens: 330,
        },
      ),
    ])

    const [usage] = await readCodexUsageHistory(filePath)
    expect(usage?.tokens).toMatchObject({
      observedInputTokens: 1_300,
      uncachedInputTokens: 650,
      cachedInputTokens: 500,
      cacheWrite5mInputTokens: 150,
      outputTokens: 130,
      processedTokens: 1_430,
    })
  })

  it('uses copied parent totals only as the baseline for a spawned subagent', async () => {
    const filePath = await usageFile([
      {
        timestamp: '2026-06-02T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'child-session',
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: 'parent-session', depth: 1 },
            },
          },
        },
      },
      {
        timestamp: '2026-06-02T10:00:00.100Z',
        type: 'session_meta',
        payload: { id: 'parent-session' },
      },
      tokenCount('2026-06-02T10:00:01.000Z', {
        input_tokens: 1_000,
        output_tokens: 100,
        total_tokens: 1_100,
      }),
      {
        timestamp: '2026-06-02T10:00:02.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' },
      },
      tokenCount('2026-06-02T10:01:00.000Z', {
        input_tokens: 1_150,
        output_tokens: 125,
        total_tokens: 1_275,
      }),
    ])

    expect(await readCodexUsageHistory(filePath)).toEqual([
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        sessionId: 'child-session',
        tokens: expect.objectContaining({
          observedInputTokens: 150,
          outputTokens: 25,
          processedTokens: 175,
        }),
      }),
    ])
  })

  it('waits for the subagent communication boundary after copied turn context', async () => {
    const filePath = await usageFile([
      {
        timestamp: '2026-06-02T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'child-session',
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: 'parent-session', depth: 1 },
            },
          },
        },
      },
      {
        timestamp: '2026-06-02T10:00:00.100Z',
        type: 'session_meta',
        payload: { id: 'parent-session' },
      },
      {
        timestamp: '2026-06-02T10:00:00.200Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' },
      },
      tokenCount('2026-06-02T10:00:01.000Z', {
        input_tokens: 1_000,
        output_tokens: 100,
        total_tokens: 1_100,
      }),
      {
        timestamp: '2026-06-02T10:00:02.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' },
      },
      {
        timestamp: '2026-06-02T10:00:02.100Z',
        type: 'inter_agent_communication_metadata',
        payload: {},
      },
      tokenCount('2026-06-02T10:01:00.000Z', {
        input_tokens: 1_150,
        output_tokens: 125,
        total_tokens: 1_275,
      }),
    ])

    expect(await readCodexUsageHistory(filePath)).toEqual([
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        sessionId: 'child-session',
        tokens: expect.objectContaining({
          observedInputTokens: 150,
          outputTokens: 25,
          processedTokens: 175,
        }),
      }),
    ])
  })
})

async function usageFile(records: unknown[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-codex-usage-'))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, 'session.jsonl')
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return filePath
}

function tokenCount(
  timestamp: string,
  total: Record<string, unknown>,
  last?: Record<string, unknown>,
): unknown {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: total,
        ...(last ? { last_token_usage: last } : {}),
      },
    },
  }
}
