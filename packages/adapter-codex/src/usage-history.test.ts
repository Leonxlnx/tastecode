import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LocalUsageRecord } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_USAGE_HISTORY,
  readCodexUsageHistory,
  resumeCodexUsageHistory,
} from './usage-history.js'

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

  it('waits for the first communication boundary and keeps usage after later markers', async () => {
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
      {
        timestamp: '2026-06-02T10:01:01.000Z',
        type: 'inter_agent_communication_metadata',
        payload: {},
      },
      tokenCount('2026-06-02T10:02:00.000Z', {
        input_tokens: 1_200,
        output_tokens: 150,
        total_tokens: 1_350,
      }),
    ])

    expect(await readCodexUsageHistory(filePath)).toEqual([
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        sessionId: 'child-session',
        tokens: expect.objectContaining({
          observedInputTokens: 200,
          outputTokens: 50,
          processedTokens: 250,
        }),
      }),
    ])
  })
})

describe('continued Codex usage history', () => {
  const plainRollout = [
    { timestamp: '2026-06-02T10:00:00.000Z', type: 'session_meta', payload: { id: 'session' } },
    {
      timestamp: '2026-06-02T10:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol' },
    },
    tokenCount('2026-06-02T10:01:00.000Z', {
      input_tokens: 1_000,
      cached_input_tokens: 400,
      output_tokens: 100,
      total_tokens: 1_100,
    }),
    tokenCount('2026-06-02T10:02:00.000Z', {
      input_tokens: 1_800,
      cached_input_tokens: 500,
      output_tokens: 180,
      reasoning_output_tokens: 40,
      total_tokens: 1_980,
    }),
    {
      timestamp: '2026-06-02T10:02:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna' },
    },
    // A rollback: the cumulative total drops, so the last usage counts.
    tokenCount(
      '2026-06-02T10:03:00.000Z',
      { input_tokens: 300, output_tokens: 30, total_tokens: 330 },
      { input_tokens: 300, output_tokens: 30, total_tokens: 330 },
    ),
    {
      timestamp: '2026-06-02T10:03:30.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message' },
    },
    tokenCount('2026-06-03T10:04:00.000Z', {
      input_tokens: 400_000,
      output_tokens: 50,
      total_tokens: 400_050,
    }),
    tokenCount('2026-06-03T10:05:00.000Z', undefined, {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    }),
  ]
  const subagentMeta = {
    timestamp: '2026-06-02T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: 'child-session',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
    },
  }
  const copiedParent = [
    { timestamp: '2026-06-02T10:00:00.100Z', type: 'session_meta', payload: { id: 'parent' } },
    tokenCount('2026-06-02T10:00:01.000Z', { input_tokens: 1_000, total_tokens: 1_000 }),
    {
      timestamp: '2026-06-02T10:00:02.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol' },
    },
    tokenCount('2026-06-02T10:00:03.000Z', { input_tokens: 1_100, total_tokens: 1_100 }),
  ]
  const markedSubagent = [
    subagentMeta,
    ...copiedParent,
    {
      timestamp: '2026-06-02T10:00:04.000Z',
      type: 'inter_agent_communication_metadata',
      payload: {},
    },
    tokenCount('2026-06-02T10:01:00.000Z', {
      input_tokens: 1_150,
      output_tokens: 25,
      total_tokens: 1_175,
    }),
    tokenCount('2026-06-02T10:02:00.000Z', {
      input_tokens: 1_300,
      output_tokens: 40,
      total_tokens: 1_340,
    }),
  ]
  const legacySubagent = [
    subagentMeta,
    ...copiedParent,
    tokenCount('2026-06-02T10:01:00.000Z', {
      input_tokens: 1_150,
      output_tokens: 25,
      total_tokens: 1_175,
    }),
  ]

  it('adds up to a full read wherever the rollout was cut', async () => {
    for (const [name, records] of Object.entries({
      plainRollout,
      markedSubagent,
      legacySubagent,
    })) {
      const full = await readCodexUsageHistory(await usageFile(records))
      const startedOver: number[] = []
      for (let cut = 1; cut < records.length; cut += 1) {
        const filePath = await usageFile(records.slice(0, cut))
        const first = await resumeCodexUsageHistory(filePath)
        await appendFile(filePath, jsonLines(records.slice(cut)))
        const second = await resumeCodexUsageHistory(filePath, first.checkpoint)
        const combined = second.appended ? [...first.entries, ...second.entries] : second.entries
        expect(summed(combined), `${name} cut after line ${cut}`).toEqual(summed(full))
        if (!second.appended) startedOver.push(cut)
      }
      // Only a cut while copied parent usage is buffered makes the next read start over.
      expect(startedOver, name).toEqual(name === 'plainRollout' ? [] : [5])
    }
  })

  it('reads the whole rollout again when its saved state is not one it wrote', async () => {
    const filePath = await usageFile(plainRollout.slice(0, 4))
    const { checkpoint } = await resumeCodexUsageHistory(filePath)
    await appendFile(filePath, jsonLines(plainRollout.slice(4)))
    const damaged = checkpoint && { ...checkpoint, state: { version: 99 } }
    const again = await resumeCodexUsageHistory(filePath, damaged)
    expect(again.appended).toBe(false)
    expect(summed(again.entries)).toEqual(summed(await readCodexUsageHistory(filePath)))
  })
})

describe('Codex usage history source', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads rollouts from the sessions folder of the given home, CODEX_HOME or ~/.codex', async () => {
    const account = path.join(os.tmpdir(), 'codex-account')
    expect(CODEX_USAGE_HISTORY.root(account)).toBe(path.join(account, 'sessions'))

    vi.stubEnv('CODEX_HOME', path.join(os.tmpdir(), 'codex-home'))
    expect(CODEX_USAGE_HISTORY.root()).toBe(path.join(os.tmpdir(), 'codex-home', 'sessions'))

    vi.stubEnv('CODEX_HOME', undefined)
    expect(CODEX_USAGE_HISTORY.root()).toBe(path.join(os.homedir(), '.codex', 'sessions'))

    const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-codex-sessions-'))
    temporaryDirectories.push(directory)
    await writeFile(path.join(directory, 'rollout.jsonl'), '{}\n')
    const archive = await CODEX_USAGE_HISTORY.discover(directory)
    expect(
      archive.files.map((file) => [path.basename(file.path), file.read, file.readFrom]),
    ).toEqual([['rollout.jsonl', readCodexUsageHistory, resumeCodexUsageHistory]])
  })
})

async function usageFile(records: unknown[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-codex-usage-'))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, 'session.jsonl')
  await writeFile(filePath, jsonLines(records))
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

function tokenCount(
  timestamp: string,
  total: Record<string, unknown> | undefined,
  last?: Record<string, unknown>,
) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        ...(total ? { total_token_usage: total } : {}),
        ...(last ? { last_token_usage: last } : {}),
      },
    },
  }
}
