import { describe, expect, it } from 'vitest'
import { DomainEventSchema, ItemSchema } from './domain.js'
import {
  channels,
  ErrorCode,
  methods,
  PushSchema,
  RequestSchema,
  ResponseSchema,
} from './protocol.js'

describe('domain events', () => {
  it('accepts a streaming delta', () => {
    const event = {
      type: 'item.delta',
      turnId: 't1',
      itemId: 'i1',
      textDelta: 'hello',
    }
    expect(DomainEventSchema.parse(event)).toEqual(event)
  })

  it('rejects an event with an unknown type instead of passing it through', () => {
    // Silently accepting unknown events is how a client and server drift apart
    // without anyone noticing. Adapters must map to `unknown` explicitly.
    expect(() => DomainEventSchema.parse({ type: 'item.exploded' })).toThrow()
  })

  it('keeps unrecognised adapter output as an unknown item rather than dropping it', () => {
    const item = ItemSchema.parse({
      id: 'i1',
      turnId: 't1',
      type: 'unknown',
      status: 'completed',
      text: 'some shape we did not expect',
      createdAt: Date.now(),
    })
    expect(item.type).toBe('unknown')
  })

  it('accepts automatic approval review progress and results', () => {
    const review = {
      id: 'review-1',
      turnId: 'turn-1',
      status: 'approved' as const,
      description: 'Run npm test',
      rationale: 'The command only runs the local test suite.',
      riskLevel: 'low' as const,
      startedAt: 10,
      completedAt: 20,
    }

    expect(DomainEventSchema.parse({ type: 'approval.review.completed', review })).toEqual({
      type: 'approval.review.completed',
      review,
    })
  })
})

describe('protocol envelopes', () => {
  it('validates a request envelope', () => {
    expect(RequestSchema.parse({ id: '1', method: 'system.info', params: {} })).toBeTruthy()
  })

  it('requires a sequence on every push so clients can detect gaps', () => {
    expect(() => PushSchema.parse({ channel: 'server.welcome', data: {} })).toThrow()
  })

  it('validates params for every declared method', () => {
    expect(
      methods['thread.start'].params.parse({
        provider: 'codex',
        workspacePath: 'D:\\x',
        serviceTier: 'priority',
        approval: 'auto-review',
      }),
    ).toBeTruthy()
    expect(
      methods['thread.sendTurn'].params.parse({
        threadId: 'th1',
        text: 'hello',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        serviceTier: 'priority',
      }),
    ).toBeTruthy()
    expect(
      methods['thread.sendTurn'].result.parse({
        queued: true,
        queuedTurn: {
          id: 'queued-1',
          text: 'Do this next',
          attachments: ['D:\\x\\reference.png'],
          createdAt: 10,
        },
      }),
    ).toBeTruthy()
    expect(methods['thread.queue'].result.parse({ items: [], canSteer: true })).toEqual({
      items: [],
      canSteer: true,
    })
    expect(() => methods['thread.start'].params.parse({ provider: 'nope' })).toThrow()
    const { undo } = methods['thread.restore'].result.parse({ undo: 'restore-token' })
    expect(methods['thread.undoRestore'].params.parse({ threadId: 'th1', undo })).toEqual({
      threadId: 'th1',
      undo,
    })
    expect(() => methods['thread.restore'].result.parse({ undo: '' })).toThrow()
    const projects = methods['projects.list'].result.parse({
      projects: [
        {
          path: 'D:\\x',
          name: 'x',
          pinned: false,
          createdAt: 0,
          sessions: [
            {
              id: 'th1',
              title: 'Isolated',
              provider: 'codex',
              createdAt: 0,
              running: true,
              worktreeBranch: 'harness/th1',
            },
          ],
        },
      ],
    })
    expect(projects.projects[0]?.sessions[0]?.worktreeBranch).toBe('harness/th1')
    expect(
      methods['workspace.switchBranch'].params.parse({ path: 'D:\\x', branch: 'feature/shelf' }),
    ).toEqual({ path: 'D:\\x', branch: 'feature/shelf' })
  })

  it('reports every panic-stop target as interrupted or failed', () => {
    const result = methods['system.panicStop'].result.parse({
      sessions: [
        { threadId: 'thread-1', status: 'interrupted' },
        { threadId: 'thread-2', status: 'failed', error: 'Adapter did not respond' },
      ],
    })

    expect(result.sessions).toHaveLength(2)
    expect(() =>
      methods['system.panicStop'].result.parse({
        sessions: [{ threadId: 'thread-2', status: 'failed' }],
      }),
    ).toThrow()
  })

  it('keeps unreported usage cost absent', () => {
    const result = methods['usage.summary'].result.parse({
      session: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 16,
      },
      today: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 16,
        costUsd: 0.04,
      },
      limits: [{ label: '5 hours', usedPercent: 25, resetsAt: 1_800_000 }],
    })

    expect(result.session.costUsd).toBeUndefined()
    expect(result.today.costUsd).toBe(0.04)
    expect(result.limits[0]?.usedPercent).toBe(25)
  })

  it('validates versioned diff review and stale snapshot errors', () => {
    const diff = {
      threadId: 'thread-1',
      version: 'snapshot-1',
      files: [
        {
          path: 'src/index.ts',
          status: 'modified' as const,
          binary: false,
          hunks: [
            {
              id: 'hunk-1',
              header: '@@ -1 +1 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: 'deletion' as const, oldLine: 1, text: 'old' },
                { kind: 'addition' as const, newLine: 1, text: 'new' },
              ],
            },
          ],
        },
      ],
    }

    expect(methods['thread.diff'].result.parse(diff)).toEqual(diff)
    expect(
      methods['thread.reviewHunk'].params.parse({
        threadId: 'thread-1',
        version: 'snapshot-1',
        path: 'src/index.ts',
        hunkId: 'hunk-1',
        decision: 'reject',
      }).decision,
    ).toBe('reject')
    expect(
      ResponseSchema.parse({
        id: 'request-1',
        error: { code: ErrorCode.STALE_SNAPSHOT, message: 'Refresh the diff and try again.' },
      }),
    ).toMatchObject({ error: { code: 'stale_snapshot' } })
  })

  it('validates paginated cross-session search', () => {
    expect(
      methods['search.sessions'].params.parse({
        query: ' regression ',
        projectPath: 'D:\\project',
        provider: 'codex',
        cursor: 'current-page',
        limit: 25,
      }),
    ).toEqual({
      query: 'regression',
      projectPath: 'D:\\project',
      provider: 'codex',
      cursor: 'current-page',
      limit: 25,
    })
    expect(
      methods['search.sessions'].result.parse({
        results: [
          {
            projectPath: 'D:\\project',
            projectName: 'project',
            threadId: 'thread-1',
            threadTitle: 'Find the regression',
            turnId: 'turn-2',
            provider: 'codex',
            createdAt: 42,
            snippet: [
              { text: 'The ', highlighted: false },
              { text: 'regression', highlighted: true },
              { text: ' started here.', highlighted: false },
            ],
          },
        ],
        nextCursor: 'next-page',
      }).nextCursor,
    ).toBe('next-page')
    expect(() => methods['search.sessions'].result.parse({ results: [], nextCursor: '' })).toThrow()
    expect(() => methods['search.sessions'].params.parse({ query: '   ' })).toThrow()
    expect(() =>
      methods['search.sessions'].params.parse({ query: 'regression', limit: 101 }),
    ).toThrow()
  })

  it('bounds normalized voice clips at the protocol boundary', () => {
    const valid = {
      requestId: '0dca4330-66f5-4f68-9287-c6b2bf4c6bf0',
      provider: 'codex' as const,
      audioBase64: 'UklGRg==',
      mimeType: 'audio/wav' as const,
      sampleRateHz: 24_000 as const,
      durationMs: 1_000,
    }

    expect(methods['voice.transcribe'].params.parse(valid)).toEqual(valid)
    expect(() =>
      methods['voice.transcribe'].params.parse({ ...valid, durationMs: 120_001 }),
    ).toThrow()
    expect(() =>
      methods['voice.transcribe'].params.parse({ ...valid, mimeType: 'audio/webm' }),
    ).toThrow()
    expect(() =>
      methods['voice.transcribe'].params.parse({ ...valid, audioBase64: 'not base64!' }),
    ).toThrow()
  })

  it('validates data for every declared channel', () => {
    expect(
      channels['thread.event'].parse({
        threadId: 'th1',
        event: { type: 'turn.completed', turnId: 't1', status: 'completed' },
      }),
    ).toBeTruthy()
    expect(
      channels['thread.queue'].parse({
        threadId: 'th1',
        items: [
          {
            id: 'queued-1',
            text: 'Do this next',
            attachments: [],
            createdAt: 10,
          },
        ],
        canSteer: false,
      }),
    ).toBeTruthy()
  })
})
