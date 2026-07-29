import { describe, expect, it } from 'vitest'
import { toDomainEvents, toUsage } from './events.js'

/**
 * Fixtures captured from claude-code 2.1.220's actual output.
 *
 * This adapter reads a shape we do not control and no generator exists for, so
 * the tests are the contract. When the CLI changes, these are what tell us.
 */

describe('claude event translation', () => {
  it('turns an assistant text block into a message', () => {
    const events = toDomainEvents(
      {
        type: 'assistant',
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
      't1',
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'item.completed',
      item: { type: 'message', role: 'assistant', text: 'hi' },
    })
  })

  it('splits a message carrying text and a tool call into separate items', () => {
    // Claude Code batches where Codex streams: one envelope, several things.
    const events = toDomainEvents(
      {
        type: 'assistant',
        message: {
          id: 'msg_2',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'node -v' } },
          ],
        },
      },
      't1',
    )
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ item: { type: 'command', command: 'node -v' } })
  })

  it('reads an edit tool as a file change, not a generic tool call', () => {
    const events = toDomainEvents(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } }],
        },
      },
      't1',
    )
    expect(events[0]).toMatchObject({ item: { type: 'file_change', path: 'src/app.ts' } })
  })

  it('maps thinking blocks to reasoning', () => {
    const events = toDomainEvents(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
      't1',
    )
    expect(events[0]).toMatchObject({ item: { type: 'reasoning', text: 'hmm' } })
  })

  it('reads a failed tool result as an error rather than output', () => {
    const events = toDomainEvents(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'not found', is_error: true },
          ],
        },
      },
      't1',
    )
    expect(events[0]).toMatchObject({ item: { type: 'error', text: 'not found' } })
  })

  it('flattens tool results that arrive as content blocks rather than a string', () => {
    const events = toDomainEvents(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'v22' }] },
          ],
        },
      },
      't1',
    )
    expect(events[0]).toMatchObject({ item: { text: 'v22' } })
  })

  it('ends the turn on result, and reports failure as failure', () => {
    expect(toDomainEvents({ type: 'result', is_error: false }, 't1')).toContainEqual({
      type: 'turn.completed',
      turnId: 't1',
      status: 'completed',
    })
    expect(toDomainEvents({ type: 'result', is_error: true }, 't1')).toContainEqual({
      type: 'turn.completed',
      turnId: 't1',
      status: 'failed',
    })
  })

  it('ignores envelopes it does not understand instead of throwing', () => {
    // The shape will change. A session must not die because of a new event.
    expect(toDomainEvents({ type: 'some_future_event' }, 't1')).toEqual([])
    expect(toDomainEvents({}, 't1')).toEqual([])
  })

  it('counts cached tokens, which dominate real usage', () => {
    const usage = toUsage({
      input_tokens: 2,
      output_tokens: 4,
      cache_read_input_tokens: 24787,
      cache_creation_input_tokens: 9297,
    })
    expect(usage).toMatchObject({ cachedInputTokens: 24787, totalTokens: 34090 })
  })
})
