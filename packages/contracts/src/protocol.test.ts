import { describe, expect, it } from 'vitest'
import { DomainEventSchema, ItemSchema } from './domain.js'
import { channels, methods, PushSchema, RequestSchema } from './protocol.js'

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
  })
})
