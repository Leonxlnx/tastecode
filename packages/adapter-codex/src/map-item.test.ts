import { describe, expect, it } from 'vitest'
import type { ThreadItem } from './generated/v2/ThreadItem.js'
import { mapThreadItem } from './map-item.js'

const context = { turnId: 'turn-1', status: 'completed', createdAt: 10 } as const

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
