import { describe, expect, it } from 'vitest'
import { Streamer } from './events.js'
import type { SessionUpdate } from './protocol.js'

/**
 * Fixtures are real frames captured from `gemini --experimental-acp`, not
 * hand-written guesses. Where a shape was invented for a test it is one the
 * schema permits but this agent happened not to emit.
 */

const chunk = (
  kind: 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
): SessionUpdate => ({
  sessionUpdate: kind,
  content: { type: 'text', text },
})

describe('Streamer', () => {
  it('folds consecutive text chunks into one growing item', () => {
    const streamer = new Streamer('t1')

    const first = streamer.translate(chunk('agent_message_chunk', 'hello'))
    const second = streamer.translate(chunk('agent_message_chunk', ' world'))

    expect(first[0]?.type).toBe('item.started')
    expect(second).toEqual([
      { type: 'item.delta', turnId: 't1', itemId: expect.any(String), textDelta: ' world' },
    ])
    // The delta must target the item the first chunk opened.
    const started = first[0]
    const delta = second[0]
    if (started?.type !== 'item.started' || delta?.type !== 'item.delta') throw new Error('shape')
    expect(delta.itemId).toBe(started.item.id)
  })

  it('keeps thinking separate from the answer', () => {
    const streamer = new Streamer('t1')

    streamer.translate(chunk('agent_message_chunk', 'answer'))
    const thought = streamer.translate(chunk('agent_thought_chunk', 'reasoning'))

    // A thought must open its own item rather than appending to the message.
    expect(thought[0]?.type).toBe('item.started')
    const event = thought[0]
    if (event?.type !== 'item.started') throw new Error('shape')
    expect(event.item.type).toBe('reasoning')
  })

  it('renders an execute tool call as a command', () => {
    const streamer = new Streamer('t1')

    const events = streamer.translate({
      sessionUpdate: 'tool_call',
      toolCallId: 'run_shell_command-1785404820393',
      status: 'in_progress',
      title: 'node -v',
      kind: 'execute',
      content: [],
      locations: [],
    })

    const event = events[0]
    if (event?.type !== 'item.started') throw new Error('shape')
    expect(event.item.type).toBe('command')
    expect(event.item.command).toBe('node -v')
  })

  it('attaches tool output to the call that produced it', () => {
    const streamer = new Streamer('t1')

    const events = streamer.translate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'run_shell_command-1785404820393',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'v22.22.2' } }],
    })

    const event = events[0]
    if (event?.type !== 'item.completed') throw new Error('shape')
    expect(event.item.id).toBe('run_shell_command-1785404820393')
    expect(event.item.text).toContain('v22.22.2')
  })

  it('keeps a command a command when the completion frame omits its kind', () => {
    const streamer = new Streamer('t1')

    // Exactly what gemini-cli sends: the start carries kind and title, the
    // completion carries neither.
    streamer.translate({
      sessionUpdate: 'tool_call',
      toolCallId: 'run_shell_command-1',
      status: 'in_progress',
      title: 'node -v',
      kind: 'execute',
    })
    const done = streamer.translate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'run_shell_command-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'v22.22.2' } }],
    })

    const event = done[0]
    if (event?.type !== 'item.completed') throw new Error('shape')
    // Without carrying the kind forward this arrives as an anonymous "tool"
    // and replaces the row that showed what was actually run.
    expect(event.item.type).toBe('command')
    expect(event.item.command).toBe('node -v')
  })

  it('takes a permissioned call’s identity from the permission request', () => {
    const streamer = new Streamer('t1')

    // Gemini describes a call needing permission only in the request, then
    // sends one completion update with neither kind nor title.
    streamer.note('run_shell_command-2', { kind: 'execute', title: 'rm -rf build' })
    const done = streamer.translate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'run_shell_command-2',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    })

    const event = done[0]
    if (event?.type !== 'item.completed') throw new Error('shape')
    expect(event.item.type).toBe('command')
    expect(event.item.command).toBe('rm -rf build')
  })

  it('starts a new paragraph after a tool call', () => {
    const streamer = new Streamer('t1')

    streamer.translate(chunk('agent_message_chunk', 'before'))
    streamer.translate({
      sessionUpdate: 'tool_call',
      toolCallId: 'x',
      kind: 'execute',
      title: 'ls',
    })
    const after = streamer.translate(chunk('agent_message_chunk', 'after'))

    // Appending "after" to the "before" item would read as one thought.
    expect(after[0]?.type).toBe('item.started')
  })

  it('turns an edit into a file change and a diff', () => {
    const streamer = new Streamer('t1')

    const events = streamer.translate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'old', newText: 'new' }],
    })

    const item = events.find((e) => e.type === 'item.completed')
    const diff = events.find((e) => e.type === 'diff.updated')
    if (item?.type !== 'item.completed' || diff?.type !== 'diff.updated') throw new Error('shape')
    expect(item.item.type).toBe('file_change')
    expect(item.item.path).toBe('/repo/a.ts')
    expect(diff.diff).toContain('-old')
    expect(diff.diff).toContain('+new')
  })

  it('treats a new file as an addition rather than emitting a bare marker', () => {
    const streamer = new Streamer('t1')

    const events = streamer.translate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-2',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'line' }],
    })

    const diff = events.find((e) => e.type === 'diff.updated')
    if (diff?.type !== 'diff.updated') throw new Error('shape')
    expect(diff.diff).toContain('+line')
    // Only the `--- a/…` header may start with a minus; there is nothing to remove.
    const removals = diff.diff.split('\n').filter((line) => /^-[^-]/.test(line))
    expect(removals).toEqual([])
  })

  it('maps plan entries onto our own statuses', () => {
    const streamer = new Streamer('t1')

    const events = streamer.translate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'done thing', status: 'completed' },
        { content: 'doing thing', status: 'in_progress' },
        { content: 'later thing', status: 'pending' },
      ],
    })

    const event = events[0]
    if (event?.type !== 'plan.updated') throw new Error('shape')
    expect(event.steps.map((s) => s.status)).toEqual(['done', 'running', 'pending'])
  })

  it('ignores updates it does not understand instead of throwing', () => {
    const streamer = new Streamer('t1')

    expect(
      streamer.translate({ sessionUpdate: 'current_mode_update', currentModeId: 'x' }),
    ).toEqual([])
    expect(streamer.translate({ sessionUpdate: 'something_new_in_2027' })).toEqual([])
    expect(streamer.translate({})).toEqual([])
  })

  it('does not emit an item for an empty chunk', () => {
    const streamer = new Streamer('t1')
    expect(streamer.translate(chunk('agent_message_chunk', ''))).toEqual([])
  })

  it('starts a fresh item after a reset, so turns do not bleed together', () => {
    const streamer = new Streamer('t1')

    streamer.translate(chunk('agent_message_chunk', 'turn one'))
    streamer.reset()
    const next = streamer.translate(chunk('agent_message_chunk', 'turn two'))

    expect(next[0]?.type).toBe('item.started')
  })
})
