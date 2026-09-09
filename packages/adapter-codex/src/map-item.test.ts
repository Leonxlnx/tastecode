import { describe, expect, it } from 'vitest'
import type { ThreadItem } from './generated/v2/ThreadItem.js'
import { CodexThreadItemSchema, mapThreadItem } from './map-item.js'

const context = { turnId: 'turn-1', status: 'completed', createdAt: 10 } as const

/** Sanitized lifecycle item captured from Codex 0.147.0 on Windows. */
const capturedImageView = {
  type: 'imageView',
  id: 'exec-e4010f67-cbbb-4f18-8e4b-aa4baf3a2d3c',
  path: 'D:\\project\\qa\\desktop.png',
} satisfies ThreadItem

function collab(overrides: Partial<Extract<ThreadItem, { type: 'collabAgentToolCall' }>> = {}) {
  return {
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'parent',
    receiverThreadIds: ['child-1'],
    prompt: 'Audit the reducer',
    model: null,
    reasoningEffort: null,
    agentsStates: { 'child-1': { status: 'running', message: null } },
    ...overrides,
  } satisfies ThreadItem
}

describe('Codex collaboration items', () => {
  it('keeps an in-progress spawn visibly running', () => {
    expect(mapThreadItem(collab({ status: 'inProgress' }), context)).toMatchObject({
      type: 'tool_call',
      status: 'started',
      text: 'Spawning a subagent',
    })
  })

  it('maps a parallel spawn to one readable provider-neutral activity', () => {
    expect(
      mapThreadItem(
        collab({
          receiverThreadIds: ['child-1', 'child-2'],
          agentsStates: {
            'child-1': { status: 'running', message: null },
            'child-2': { status: 'pendingInit', message: null },
          },
        }),
        context,
      ),
    ).toMatchObject({
      id: 'collab-1',
      type: 'tool_call',
      status: 'completed',
      text: 'Spawned 2 subagents',
    })
  })

  it('surfaces failed child state even when the wait call itself completed', () => {
    expect(
      mapThreadItem(
        collab({
          tool: 'wait',
          receiverThreadIds: ['child-1', 'child-2'],
          agentsStates: {
            'child-1': { status: 'completed', message: 'done' },
            'child-2': { status: 'errored', message: 'process exited' },
          },
        }),
        context,
      ),
    ).toMatchObject({ type: 'tool_call', status: 'failed', text: '1 of 2 subagents failed' })
  })

  it('maps legacy subagent activity without exposing a raw provider type', () => {
    expect(
      mapThreadItem(
        {
          type: 'subAgentActivity',
          id: 'activity-1',
          kind: 'interrupted',
          agentThreadId: 'child-1',
          agentPath: 'child-1',
        },
        context,
      ),
    ).toMatchObject({ type: 'tool_call', status: 'failed', text: 'Subagent interrupted' })
  })
})

describe('Codex assistant messages', () => {
  it.each(['commentary', 'final_answer'] as const)('preserves the %s phase', (phase) => {
    expect(
      mapThreadItem(
        {
          type: 'agentMessage',
          id: `message-${phase}`,
          text: 'Provider-authored text',
          phase,
          memoryCitation: null,
        },
        context,
      ),
    ).toMatchObject({ type: 'message', role: 'assistant', phase })
  })
})

describe('Codex image inspection items', () => {
  it('maps the captured lifecycle to one stable provider-neutral activity', () => {
    const started = mapThreadItem(capturedImageView, { ...context, status: 'started' })
    const completed = mapThreadItem(capturedImageView, context)

    expect(started).toMatchObject({
      id: capturedImageView.id,
      type: 'tool_call',
      status: 'started',
      text: 'image view\ndesktop.png',
    })
    expect(completed).toMatchObject({
      id: capturedImageView.id,
      type: 'tool_call',
      status: 'completed',
      text: 'image view\ndesktop.png',
    })
    expect(completed.text).not.toContain('D:\\project')
  })

  it('keeps sequential views distinct and ordered', () => {
    const items = [
      capturedImageView,
      { ...capturedImageView, id: 'exec-image-2', path: '/project/qa/mobile.png' },
    ].map((item) => mapThreadItem(item, context))

    expect(items.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: capturedImageView.id, text: 'image view\ndesktop.png' },
      { id: 'exec-image-2', text: 'image view\nmobile.png' },
    ])
  })

  it('preserves a failed lifecycle without claiming the image was viewed', () => {
    expect(mapThreadItem(capturedImageView, { ...context, status: 'failed' })).toMatchObject({
      type: 'tool_call',
      status: 'failed',
      text: 'image view\ndesktop.png',
    })
  })
})

describe('Codex context compaction items', () => {
  it('maps context compaction to a provider-neutral tool activity', () => {
    expect(
      mapThreadItem(
        { type: 'contextCompaction', id: 'compaction-1' },
        { ...context, status: 'started' },
      ),
    ).toMatchObject({
      id: 'compaction-1',
      type: 'tool_call',
      status: 'started',
      text: 'context compaction',
    })
  })
})

describe('Codex activity items', () => {
  it.each([
    [
      {
        type: 'hookPrompt',
        id: 'hook-1',
        fragments: [{ text: 'Check the changed files', hookRunId: 'run-1' }],
      },
      'hook prompt',
    ],
    [{ type: 'sleep', id: 'sleep-1', durationMs: 1_000 }, 'sleep'],
    [
      {
        type: 'imageGeneration',
        id: 'image-1',
        status: 'completed',
        revisedPrompt: null,
        result: 'image bytes omitted',
      },
      'image generation',
    ],
    [
      { type: 'enteredReviewMode', id: 'review-in', review: 'Review the change' },
      'enter review mode',
    ],
    [{ type: 'exitedReviewMode', id: 'review-out', review: 'Review complete' }, 'exit review mode'],
    [{ type: 'contextCompaction', id: 'compact-1' }, 'context compaction'],
  ] satisfies Array<[ThreadItem, string]>)('maps $type to a named tool activity', (raw, text) => {
    expect(mapThreadItem(raw, context)).toMatchObject({
      id: raw.id,
      type: 'tool_call',
      text,
    })
  })

  it('keeps the duration for tools that report one', () => {
    expect(
      mapThreadItem(
        {
          type: 'dynamicToolCall',
          id: 'dynamic-1',
          namespace: 'workspace',
          tool: 'inspect',
          arguments: {},
          status: 'completed',
          contentItems: null,
          success: true,
          durationMs: 240,
        },
        context,
      ),
    ).toMatchObject({ type: 'tool_call', text: 'inspect', durationMs: 240 })
  })

  it('preserves valid empty and zero command results', () => {
    const item = CodexThreadItemSchema.parse({
      type: 'commandExecution',
      id: 'command-1',
      command: 'true',
      aggregatedOutput: '',
      exitCode: 0,
      durationMs: 0,
    })

    expect(mapThreadItem(item, context)).toMatchObject({
      type: 'command',
      text: '',
      exitCode: 0,
      durationMs: 0,
    })
  })

  it('keeps future provider items visible without accepting malformed known items', () => {
    const future = CodexThreadItemSchema.parse({
      type: 'futureActivity',
      id: 'future-1',
      providerOnlyField: true,
    })

    expect(mapThreadItem(future, context)).toMatchObject({
      id: 'future-1',
      type: 'unknown',
      text: '[futureActivity]',
    })
    expect(() =>
      CodexThreadItemSchema.parse({ type: 'commandExecution', id: 'broken-command' }),
    ).toThrow()
  })
})
