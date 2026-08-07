import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  AntigravityAdapter,
  ANTIGRAVITY_CAPABILITIES,
  antigravityTurnArgs,
  parseAntigravityModels,
} from './adapter.js'

/** Frames captured from agy 1.1.10 on Windows through real non-TTY pipes. */
const CAPTURED_FRAMES = [
  '{"event":"init","conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","init":{"model":"gemini-3.6-flash-low","cwd":"C:\\\\tmp"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"MOND"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"LICHT\\n","usage":{"input_tokens":26267,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":26270}}',
  '{"event":"step_update","step_update":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","step_index":3,"state":"DONE","step_type":"checkpoint"}}',
  '{"event":"result","result":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","status":"SUCCESS","response":"MONDLICHT\\n","num_turns":1,"usage":{"input_tokens":26368,"output_tokens":6,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":26374}}}',
]

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
}

function fakeSpawn(record: { command?: string; args?: string[] }, child: FakeChild) {
  return (command: string, args: string[]) => {
    record.command = command
    record.args = args
    return child as unknown as ChildProcessWithoutNullStreams
  }
}

describe('Antigravity turn invocation', () => {
  it('maps approval modes onto the CLI switches', () => {
    expect(antigravityTurnArgs('Hi', { approval: 'ask' }, undefined)).not.toContain('--mode')
    expect(antigravityTurnArgs('Hi', { approval: 'auto' }, undefined)).toContain('accept-edits')
    expect(antigravityTurnArgs('Hi', { approval: 'full' }, undefined)).toContain(
      '--dangerously-skip-permissions',
    )
  })

  it('resumes with the conversation id from the init frame', () => {
    const args = antigravityTurnArgs('Hi', {}, 'conv-1')
    expect(args.slice(-2)).toEqual(['--conversation', 'conv-1'])
  })

  it('streams a captured turn into message deltas, usage, and completion', async () => {
    const record: { command?: string; args?: string[] } = {}
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn(record, child) })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))

    const thread = await adapter.startThread('C:\\repo', { model: 'gemini-3.6-flash-low' })
    await adapter.sendTurn(thread.id, 'Say only the word MONDLICHT.')
    for (const frame of CAPTURED_FRAMES) child.stdout.write(`${frame}\n`)
    child.stdout.end()
    child.emit('exit', 0)
    await new Promise((resolve) => setImmediate(resolve))

    expect(record.args).toContain('stream-json')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.delta', textDelta: 'MOND' }),
        expect.objectContaining({
          type: 'item.completed',
          item: expect.objectContaining({ type: 'message', text: 'MONDLICHT' }),
        }),
        expect.objectContaining({
          type: 'usage.updated',
          usage: expect.objectContaining({ inputTokens: 26368, totalTokens: 26374 }),
        }),
        expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
      ]),
    )
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)

    // The next turn resumes the conversation the init frame announced.
    await adapter.sendTurn(thread.id, 'And again?')
    expect(record.args?.slice(-2)).toEqual([
      '--conversation',
      '9f1827a7-3506-4a85-add9-63182b9917a4',
    ])
  })

  it('reports a dead CLI instead of hanging silently', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'Hello')
    child.stdout.end()
    child.emit('exit', 3)
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thread.error' }),
        expect.objectContaining({ type: 'turn.completed', status: 'failed' }),
      ]),
    )
  })

  it('prepends session instructions to the first prompt only', async () => {
    const record: { command?: string; args?: string[] } = {}
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn(record, child) })
    const thread = await adapter.startThread('C:\\repo', {
      instructions: 'Answer plainly.\nNo filler.',
    })
    await adapter.sendTurn(thread.id, 'Hello there')
    const prompt = record.args?.[record.args.indexOf('-p') + 1]
    expect(prompt).toContain('<system-instructions>')
    expect(prompt).toContain('No filler.')
    expect(prompt).toContain('Hello there')
  })
})

describe('Antigravity model list', () => {
  it('closes stdin for discovery — the CLI blocks forever on an open pipe', async () => {
    const child = new FakeChild()
    let stdinEnded = false
    child.stdin.on('finish', () => (stdinEnded = true))
    const adapter = new AntigravityAdapter({
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    })
    const listing = adapter.listModels()
    await new Promise((resolve) => setImmediate(resolve))
    expect(stdinEnded).toBe(true)
    child.stdout.write('gemini-3.6-flash-high\n')
    child.stdout.end()
    child.emit('exit', 0)
    await expect(listing).resolves.toMatchObject([{ id: 'gemini-3.6-flash-high' }])
  })

  it('collapses the agy models output into base models with efforts', () => {
    const models = parseAntigravityModels(
      'gemini-3.6-flash-high\ngemini-3.6-flash-low\nclaude-sonnet-4-6\n',
    )
    expect(models).toMatchObject([
      {
        id: 'gemini-3.6-flash-high',
        displayName: 'Gemini 3.6 Flash',
        isDefault: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
      },
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        isDefault: false,
        reasoningEfforts: [],
      },
    ])
  })

  it('declares the print-mode capability set', () => {
    expect(ANTIGRAVITY_CAPABILITIES).toMatchObject({ steer: false, approvals: false })
  })
})
