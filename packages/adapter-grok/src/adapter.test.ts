import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  GROK_CAPABILITIES,
  GrokAdapter,
  grokPromptJson,
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
    setImmediate(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('close', null)
    })
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
  it('encodes images and files as ACP prompt content blocks', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-grok-attachment-'))
    try {
      const image = path.join(directory, 'sample.webp')
      const document = path.join(directory, 'notes.txt')
      writeFileSync(image, 'image bytes')
      writeFileSync(document, 'notes')

      expect(JSON.parse(grokPromptJson('Describe these.', [image, document]))).toEqual([
        { type: 'text', text: 'Describe these.' },
        {
          type: 'image',
          data: Buffer.from('image bytes').toString('base64'),
          mimeType: 'image/webp',
          uri: pathToFileURL(image).href,
        },
        {
          type: 'resource_link',
          name: 'notes.txt',
          uri: pathToFileURL(document).href,
        },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('maps the captured streaming-json wire format onto domain items', async () => {
    const children: FakeChild[] = []
    let args: string[] = []
    const adapter = new GrokAdapter({
      spawn: (_command, value) => {
        args = value
        const child = new FakeChild()
        children.push(child)
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
    const child = children[0]!
    const promptFile = args[args.indexOf('--prompt-file') + 1]!
    expect(readFileSync(promptFile, 'utf8')).toBe(
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nCreate hello.txt',
    )
    const fixture = readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8')
    child.stdout.end(fixture)
    await completed

    expect(args).toEqual([
      '--prompt-file',
      promptFile,
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
          item: expect.objectContaining({
            type: 'file_change',
            status: 'completed',
            text: expect.stringMatching(/hello\.txt[\s\S]*SearchReplace/),
          }),
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

  it('keeps sequential tool and authored-text lifecycles distinct', async () => {
    const child = new FakeChild()
    const adapter = new GrokAdapter({
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Create two files')
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })

    // Composed ordering probe using the captured 0.1.219 text, write, diff-update,
    // and end frame shapes. Grok is also known to reuse toolCallId sequentially.
    const frames = [
      { type: 'text', data: 'First, I will create one. ' },
      {
        type: 'tool_call',
        toolCallId: 'tool-1',
        toolName: 'write',
        title: 'write',
        rawInput: { file_path: 'C:\\repo\\one.txt' },
      },
      {
        type: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [{ type: 'diff', path: 'C:\\repo\\one.txt', oldText: '', newText: 'one' }],
        rawOutput: { type: 'SearchReplace' },
      },
      { type: 'text', data: 'Next, I will create two. ' },
      {
        type: 'tool_call',
        toolCallId: 'tool-1',
        toolName: 'write',
        title: 'write',
        rawInput: { file_path: 'C:\\repo\\two.txt' },
      },
      {
        type: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [{ type: 'diff', path: 'C:\\repo\\two.txt', oldText: '', newText: 'two' }],
        rawOutput: { type: 'SearchReplace' },
      },
      { type: 'text', data: 'Both files are ready.' },
      { type: 'end', stopReason: 'end_turn', sessionId: 'session-1' },
    ]
    child.stdout.end(frames.map((frame) => JSON.stringify(frame)).join('\n'))
    await completed

    const items = events
      .filter(
        (event): event is Extract<DomainEvent, { type: 'item.completed' }> =>
          event.type === 'item.completed',
      )
      .map((event) => event.item)
      .filter((item) => item.type === 'message' || item.type === 'file_change')
    expect(items.map(({ id }) => id)).toHaveLength(new Set(items.map(({ id }) => id)).size)
    expect(items).toMatchObject([
      { type: 'message', text: 'First, I will create one.' },
      { type: 'file_change', text: expect.stringContaining('one') },
      { type: 'message', text: 'Next, I will create two.' },
      { type: 'file_change', text: expect.stringContaining('two') },
      { type: 'message', text: 'Both files are ready.' },
    ])
  })

  it('keeps long unicode and multiline prompts off Windows argv', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new GrokAdapter({
      spawn: (_command, value) => {
        args = value
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    const text = `Grüße 🧪\n${'x'.repeat(40_000)}`
    const thread = await adapter.startThread('C:\\repo')

    await adapter.sendTurn(thread.id, text)

    const promptFile = args[args.indexOf('--prompt-file') + 1]!
    expect(args).not.toContain(text)
    expect(args.every((arg) => !/[\r\n]/.test(arg))).toBe(true)
    expect(readFileSync(promptFile, 'utf8')).toBe(text)

    child.emit('close', 0)
    expect(existsSync(promptFile)).toBe(false)
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
    child.emit('close', 1)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thread.error' }),
        expect.objectContaining({ type: 'turn.completed', status: 'failed' }),
      ]),
    )
  })

  it('ends an interrupted turn exactly once while keeping replacement and disposal silent', async () => {
    const children: FakeChild[] = []
    const adapter = new GrokAdapter({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const interruptedTurnId = await adapter.sendTurn(thread.id, 'stop me')

    await adapter.interrupt()
    await adapter.sendTurn(thread.id, 'replace me')
    await new Promise((resolve) => setImmediate(resolve))

    expect(children[0]?.killed).toBe(true)
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: interruptedTurnId, status: 'interrupted' },
    ])

    await adapter.sendTurn(thread.id, 'replacement')
    await new Promise((resolve) => setImmediate(resolve))

    expect(children[1]?.killed).toBe(true)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)

    adapter.dispose()
    await new Promise((resolve) => setImmediate(resolve))

    expect(children[2]?.killed).toBe(true)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })

  it('drains a final end frame before classifying process close', async () => {
    const child = new FakeChild()
    const adapter = new GrokAdapter({
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'finish normally')

    child.emit('exit', 0)
    const drained = new Promise<void>((resolve) => child.stdout.once('end', resolve))
    child.stdout.end(JSON.stringify({ type: 'end', stopReason: 'end_turn' }))
    await drained
    child.emit('close', 0)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
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

  it('keeps secondary models from the Grok 1.0 listing', () => {
    expect(
      parseGrokModels(
        'Default model: grok-4.6\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5',
      ),
    ).toEqual([
      {
        id: 'grok-4.6',
        displayName: 'Grok 4.6',
        isDefault: true,
        reasoningEfforts: [],
        serviceTiers: [],
      },
      {
        id: 'grok-4.5',
        displayName: 'Grok 4.5',
        isDefault: false,
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
      },
    ])
  })

  it('stops parsing after the available-model rows', () => {
    const models = parseGrokModels(
      'Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n\n  - install',
    )
    expect(models.map((model) => model.id)).toEqual(['grok-4.6', 'grok-4.5'])
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
