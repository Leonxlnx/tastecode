import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  GROK_CAPABILITIES,
  GrokAdapter,
  grokTurnArgs,
  parseGrokAccount,
  parseGrokModels,
} from './adapter.js'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    setImmediate(() => this.emit('exit', null))
    return true
  }
}

/** The models output captured from grok 0.1.219 while signed out. */
const MODELS_OUTPUT = [
  'You are not authenticated.',
  '',
  'Default model: grok-4.5',
  '',
  'Available models:',
  '  * grok-4.5 (default)',
  '',
].join('\n')

describe('Grok adapter', () => {
  it('maps the captured streaming-json wire format onto domain items', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new GrokAdapter({
      spawn: (_command, value) => {
        args = value
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo', {
      model: 'grok-4.5',
      effort: 'high',
      instructions: 'Answer plainly.',
    })
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })

    await adapter.sendTurn(thread.id, 'Create hello.txt')
    const fixture = readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8')
    child.stdout.end(fixture)
    await completed

    expect(args).toEqual([
      '-p',
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nCreate hello.txt',
      '--output-format',
      'streaming-json',
      '--model',
      'grok-4.5',
      '--reasoning-effort',
      'high',
    ])

    // Reasoning streams as its own item; the write becomes a file change.
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.delta', textDelta: 'The user wants' }),
        expect.objectContaining({
          type: 'item.started',
          item: expect.objectContaining({ type: 'file_change', path: 'C:\\repo\\hello.txt' }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          item: expect.objectContaining({ type: 'file_change', status: 'completed' }),
        }),
        expect.objectContaining({
          type: 'item.completed',
          item: expect.objectContaining({ type: 'message', text: 'done' }),
        }),
        expect.objectContaining({
          type: 'usage.updated',
          usage: expect.objectContaining({
            model: 'grok-4.5',
            inputTokens: 22116,
            cachedInputTokens: 5376,
            reasoningTokens: 83,
            inputIncludesCached: false,
            costUsd: 0.0463908,
          }),
        }),
        expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
      ]),
    )

    // The end frame's session id resumes the CLI's own session next turn.
    await adapter.sendTurn(thread.id, 'And now?', [], {
      model: 'grok-4.5',
      effort: 'low',
    })
    expect(args).toContain('-r')
    expect(args).toContain('019fd9b0-1c9b-7dd3-85a2-2b7b628382d3')
    expect(
      args.slice(args.indexOf('--reasoning-effort'), args.indexOf('--reasoning-effort') + 2),
    ).toEqual(['--reasoning-effort', 'low'])
    adapter.dispose()
  })

  it('fails the turn when the process dies without an end frame', async () => {
    const child = new FakeChild()
    const adapter = new GrokAdapter({
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'go')

    child.stdout.end('')
    child.emit('exit', 1)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thread.error' }),
        expect.objectContaining({ type: 'turn.completed', status: 'failed' }),
      ]),
    )
  })

  it('parses the captured models listing and its auth line', () => {
    expect(parseGrokModels(MODELS_OUTPUT)).toEqual([
      {
        id: 'grok-4.5',
        displayName: 'Grok 4.5',
        isDefault: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
      },
    ])
    expect(parseGrokAccount(MODELS_OUTPUT)).toEqual({ signedIn: false })
    expect(parseGrokAccount('Default model: grok-4.5\nAvailable models:\n  * grok-4.5')).toEqual({
      signedIn: true,
    })
  })

  it('does not guess reasoning levels for models without model-specific metadata', () => {
    const models = parseGrokModels('Available models:\n  * grok-future (default)')
    expect(models).toEqual([
      {
        id: 'grok-future',
        displayName: 'Grok Future',
        isDefault: true,
        reasoningEfforts: [],
        serviceTiers: [],
      },
    ])
  })

  it('maps approval modes onto the documented permission modes', () => {
    expect(grokTurnArgs('x', { approval: 'auto' }, undefined)).toContain('acceptEdits')
    expect(grokTurnArgs('x', { approval: 'full' }, undefined)).toContain('bypassPermissions')
    expect(grokTurnArgs('x', { approval: 'ask' }, undefined).join(' ')).not.toContain(
      '--permission-mode',
    )
  })

  it('declares the one-shot print-mode capability set', () => {
    expect(GROK_CAPABILITIES).toMatchObject({ steer: false, interrupt: true, reasoningItems: true })
  })
})
