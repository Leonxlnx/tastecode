import { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
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

class FakeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ]
  wasKilled = false

  override kill(): boolean {
    this.wasKilled = true
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
        return child
      },
    })
    const events: DomainEvent[] = []
    const providerSessionIds: string[] = []
    adapter.on('event', (event) => events.push(event))
    adapter.on('providerSessionId', (sessionId) => providerSessionIds.push(sessionId))
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
    const createdSessionId = args[args.indexOf('--session-id') + 1]!
    expect(readFileSync(promptFile, 'utf8')).toBe(
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nCreate hello.txt',
    )
    expect(createdSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(providerSessionIds).toEqual([createdSessionId])
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
      '--session-id',
      createdSessionId,
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
    expect(providerSessionIds).toEqual([
      createdSessionId,
      '019fd9b0-1c9b-7dd3-85a2-2b7b628382d3',
    ])

    // The end frame's session id resumes the CLI's own session next turn.
    await adapter.sendTurn(thread.id, 'And now?', [], {
      model: 'grok-4.5',
      effort: 'low',
    })
    expect(args).toContain('--resume')
    expect(args).toContain('019fd9b0-1c9b-7dd3-85a2-2b7b628382d3')
    expect(args).not.toContain('--session-id')
    expect(
      args.slice(args.indexOf('--reasoning-effort'), args.indexOf('--reasoning-effort') + 2),
    ).toEqual(['--reasoning-effort', 'low'])
    adapter.dispose()
  })

  it('resumes a stable TasteCode thread through its separate Grok session id', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new GrokAdapter({
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const providerSessionIds: string[] = []
    adapter.on('providerSessionId', (sessionId) => providerSessionIds.push(sessionId))

    const thread = await adapter.resumeThread(
      'grok-tastecode-thread',
      'grok-native-session',
      'C:\\repo',
      { instructions: 'Already present in the native session.' },
    )
    const turnId = await adapter.sendTurn(thread.id, 'Continue')

    expect(thread.id).toBe('grok-tastecode-thread')
    expect(turnId).toMatch(/^grok-tastecode-thread-turn-/)
    expect(args.slice(args.indexOf('--resume'))).toEqual(['--resume', 'grok-native-session'])
    expect(args).not.toContain('--session-id')
    expect(args).not.toContain('grok-tastecode-thread')
    expect(providerSessionIds).toEqual(['grok-native-session'])
    const promptFile = args[args.indexOf('--prompt-file') + 1]!
    expect(readFileSync(promptFile, 'utf8')).toBe('Continue')

    const learned = new Promise<void>((resolve) =>
      adapter.once('providerSessionId', () => resolve()),
    )
    child.stdout.end(
      JSON.stringify({
        type: 'end',
        stopReason: 'end_turn',
        sessionId: 'grok-native-session-rotated',
      }),
    )
    await learned
    expect(providerSessionIds).toEqual(['grok-native-session', 'grok-native-session-rotated'])
    adapter.dispose()
  })

  it('resumes the named Grok session after an interrupted first turn', async () => {
    const children: FakeChild[] = []
    const spawned: string[][] = []
    const adapter = new GrokAdapter({
      spawn: (_command, value) => {
        spawned.push(value)
        const child = new FakeChild()
        children.push(child)
        return child
      },
    })
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'first')
    const createdSessionId = spawned[0]![spawned[0]!.indexOf('--session-id') + 1]!
    await adapter.interrupt()
    await adapter.sendTurn(thread.id, 'follow-up')

    expect(spawned[1]).toContain('--resume')
    expect(spawned[1]).toContain(createdSessionId)
    expect(spawned[1]).not.toContain('--session-id')
    adapter.dispose()
  })

  it('does not reuse synthetic turn ids after an adapter restart', async () => {
    const first = new GrokAdapter({ spawn: () => new FakeChild() })
    const second = new GrokAdapter({ spawn: () => new FakeChild() })
    await first.resumeThread('grok-thread', 'native-session', 'C:\\repo')
    await second.resumeThread('grok-thread', 'native-session', 'C:\\repo')

    const firstTurn = await first.sendTurn('grok-thread', 'one')
    const secondTurn = await second.sendTurn('grok-thread', 'two')

    expect(firstTurn).not.toBe(secondTurn)
    first.dispose()
    second.dispose()
  })

  it('ignores a native session id flushed by a replaced child', async () => {
    const children: FakeChild[] = []
    const adapter = new GrokAdapter({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
    })
    const providerSessionIds: string[] = []
    adapter.on('providerSessionId', (sessionId) => providerSessionIds.push(sessionId))
    const thread = await adapter.resumeThread('grok-thread', 'native-session', 'C:\\repo')

    await adapter.sendTurn(thread.id, 'first')
    await adapter.sendTurn(thread.id, 'replacement')
    children[0]!.stdout.end(
      JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'stale-session' }),
    )
    const learned = new Promise<void>((resolve) =>
      adapter.once('providerSessionId', () => resolve()),
    )
    children[1]!.stdout.end(
      JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'current-session' }),
    )

    await learned
    expect(providerSessionIds).toEqual(['native-session', 'current-session'])
    adapter.dispose()
  })

  it('keeps sequential tool and authored-text lifecycles distinct', async () => {
    const child = new FakeChild()
    const adapter = new GrokAdapter({
      spawn: () => child,
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'Create two files')
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
        return child
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
      spawn: () => child,
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'go')

    child.stdout.end(
      [
        { type: 'thought', data: 'partial thought' },
        { type: 'tool_call', toolCallId: 'open-tool', toolName: 'read', title: 'read' },
      ]
        .map((frame) => JSON.stringify(frame))
        .join('\n') + '\n',
    )
    child.emit('close', 1)
    await new Promise((resolve) => setImmediate(resolve))

    const terminal = events.findIndex((event) => event.type === 'turn.completed')
    const completed = events.filter((event) => event.type === 'item.completed')
    expect(completed).toHaveLength(2)
    expect(completed.every((event) => event.item.status === 'failed')).toBe(true)
    expect(events.lastIndexOf(completed[1]!)).toBeLessThan(terminal)
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
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const interruptedTurnId = await adapter.sendTurn(thread.id, 'stop me')

    children[0]!.stdout.write(`${JSON.stringify({ type: 'thought', data: 'working' })}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    await adapter.interrupt()
    await adapter.sendTurn(thread.id, 'replace me')
    await new Promise((resolve) => setImmediate(resolve))

    expect(children[0]?.wasKilled).toBe(true)
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: interruptedTurnId, status: 'interrupted' },
    ])
    expect(
      events.find(
        (event) => event.type === 'item.completed' && event.item.turnId === interruptedTurnId,
      ),
    ).toMatchObject({ item: { status: 'failed' } })

    children[1]!.stdout.write(`${JSON.stringify({ type: 'thought', data: 'replacing' })}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    await adapter.sendTurn(thread.id, 'replacement')
    await new Promise((resolve) => setImmediate(resolve))

    expect(children[1]?.wasKilled).toBe(true)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(
      events.find(
        (event) => event.type === 'item.completed' && event.item.turnId !== interruptedTurnId,
      ),
    ).toMatchObject({ item: { status: 'failed' } })

    children[2]!.stdout.write(`${JSON.stringify({ type: 'thought', data: 'disposing' })}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    adapter.dispose()
    await new Promise((resolve) => setImmediate(resolve))

    expect(children[2]?.wasKilled).toBe(true)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })

  it('drains a final end frame before classifying process close', async () => {
    const child = new FakeChild()
    const adapter = new GrokAdapter({
      spawn: () => child,
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'finish normally')

    child.emit('exit', 0)
    const drained = new Promise<void>((resolve) => child.stdout.once('end', resolve))
    child.stdout.end(
      [
        { type: 'tool_call', toolCallId: 'open-tool', toolName: 'read', title: 'read' },
        { type: 'end', stopReason: 'end_turn' },
      ]
        .map((frame) => JSON.stringify(frame))
        .join('\n'),
    )
    await drained
    child.emit('close', 0)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    expect(events.find((event) => event.type === 'item.completed')).toMatchObject({
      item: { turnId, status: 'completed' },
    })
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
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
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
    expect(grokTurnArgs('x', {}, { id: 'sess-1', mode: 'create' })).toEqual(
      expect.arrayContaining(['--session-id', 'sess-1']),
    )
    expect(grokTurnArgs('x', {}, { id: 'sess-1', mode: 'resume' })).toEqual(
      expect.arrayContaining(['--resume', 'sess-1']),
    )
    expect(grokTurnArgs('x', {}, { id: 'sess-1', mode: 'create' })).not.toContain('--resume')
    expect(grokTurnArgs('x', {}, { id: 'sess-1', mode: 'resume' })).not.toContain('--session-id')
  })

  it('runs ephemeral background writing on grok-4.6 at low with a single turn', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new GrokAdapter({
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const thread = await adapter.startThread('C:\\repo', { ephemeral: true })
    await adapter.sendTurn(thread.id, 'Title this session')
    expect(args).toEqual([
      '--prompt-file',
      expect.any(String),
      '--output-format',
      'streaming-json',
      '--model',
      'grok-4.6',
      '--reasoning-effort',
      'low',
      '--max-turns',
      '1',
      '--session-id',
      expect.any(String),
    ])
    adapter.dispose()
  })

  it('declares the one-shot print-mode capability set', () => {
    expect(GROK_CAPABILITIES).toMatchObject({ steer: false, interrupt: true, reasoningItems: true })
  })
})
