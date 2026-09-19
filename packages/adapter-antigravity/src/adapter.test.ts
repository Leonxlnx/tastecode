import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  AntigravityAdapter,
  ANTIGRAVITY_CAPABILITIES,
  antigravityTurnArgs,
  parseAntigravityModels,
} from './adapter.js'
import { resetAntigravityIndexForTests } from './models.js'

/** Frames captured from agy 1.1.10 on Windows through real non-TTY pipes. */
const CAPTURED_FRAMES = [
  '{"event":"init","conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","init":{"model":"gemini-3.6-flash-low","cwd":"C:\\\\tmp"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"MOND"}}',
  '{"event":"step_update","step_update":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"LICHT\\n","usage":{"input_tokens":26267,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":26270}}',
  '{"event":"step_update","step_update":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","step_index":3,"state":"DONE","step_type":"checkpoint"}}',
  '{"event":"result","result":{"conversation_id":"9f1827a7-3506-4a85-add9-63182b9917a4","status":"SUCCESS","response":"MONDLICHT\\n","num_turns":1,"usage":{"input_tokens":26368,"output_tokens":6,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":26374}}}',
]

class FakeChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdin = new PassThrough()
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

type SpawnOptionsRecord = {
  cwd?: string
  stdio?: readonly string[]
  windowsHide?: boolean
  detached?: boolean
}
type SpawnRecord = { command?: string; args?: string[]; options?: SpawnOptionsRecord }

function fakeSpawn(record: SpawnRecord, child: FakeChild) {
  return (
    command: string,
    args: string[],
    options?: {
      cwd?: string
      stdio?: readonly string[]
      windowsHide?: boolean
      detached?: boolean
    },
  ) => {
    record.command = command
    record.args = args
    if (options) record.options = { ...options }
    return child
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
    const record: SpawnRecord = {}
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn(record, child) })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))

    const thread = await adapter.startThread('C:\\repo', { model: 'gemini-3.6-flash-low' })
    await adapter.sendTurn(thread.id, 'Say only the word MONDLICHT.')
    for (const frame of CAPTURED_FRAMES) child.stdout.write(`${frame}\n`)
    child.stdout.end()
    child.emit('close', 0)
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
    child.emit('close', 3)
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thread.error' }),
        expect.objectContaining({ type: 'turn.completed', status: 'failed' }),
      ]),
    )
  })

  it('prepends session instructions to the first prompt only', async () => {
    const record: SpawnRecord = {}
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

  it('resolves a changed effort on the next invocation', async () => {
    const [model] = parseAntigravityModels(
      'gemini-3.6-flash-high\ngemini-3.6-flash-medium\ngemini-3.6-flash-low\n',
    )
    const record: SpawnRecord = {}
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn(record, child) })
    const thread = await adapter.startThread('C:\\repo', {
      model: model!.id,
      effort: 'high',
    })

    await adapter.sendTurn(thread.id, 'Use less reasoning', [], {
      model: model!.id,
      effort: 'low',
    })

    expect(
      record.args?.slice(record.args.indexOf('--model'), record.args.indexOf('--model') + 2),
    ).toEqual(['--model', 'gemini-3.6-flash-low'])
  })

  it('refreshes a cold model index before applying an effort', async () => {
    resetAntigravityIndexForTests()
    const discovery = new FakeChild()
    const turn = new FakeChild()
    const record: SpawnRecord = {}
    const adapter = new AntigravityAdapter({
      spawn: (command, args) => {
        if (args[0] === 'models') return discovery
        return fakeSpawn(record, turn)(command, args)
      },
    })
    const thread = await adapter.startThread('C:\\repo', {
      model: 'gemini-3.6-flash-high',
      effort: 'low',
    })

    const sending = adapter.sendTurn(thread.id, 'Use less reasoning')
    discovery.stdout.write(
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n' +
        'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n',
    )
    discovery.stdout.end()
    discovery.emit('close', 0)
    await sending

    expect(
      record.args?.slice(record.args.indexOf('--model'), record.args.indexOf('--model') + 2),
    ).toEqual(['--model', 'gemini-3.6-flash-low'])
  })
})

describe('Antigravity subprocess ownership', () => {
  it('spawns helpers owned and directly, keeping multi-line prompts intact', async () => {
    const record: SpawnRecord = {}
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn(record, child) })
    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'line one\nline two')
    const prompt = record.args?.[record.args.indexOf('-p') + 1] ?? ''
    // Direct spawn, never cmd.exe or a shell: the prompt survives the newline.
    expect(record.command).toMatch(/agy/)
    expect(record.command).not.toMatch(/cmd\.exe/i)
    expect(prompt).toContain('line one\nline two')
    // Shared owned spawning: exact group contract plus pipe stdio, no shell.
    expect(record.options?.detached).toBe(process.platform !== 'win32')
    expect(record.options?.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(record.options?.windowsHide).toBe(true)
    expect(record.options).not.toHaveProperty('shell')
    await adapter.dispose()
  })

  it('emits exactly one interrupted completion without error on interrupt', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('/repo')
    const turnId = await adapter.sendTurn(thread.id, 'Hello')
    await adapter.interrupt()
    await adapter.interrupt()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(child.wasKilled).toBe(true)
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'interrupted' },
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    await adapter.dispose()
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })

  it('replaces an in-flight turn without clobbering the new child', async () => {
    const first = new FakeChild()
    const second = new FakeChild()
    const spawned: FakeChild[] = []
    const adapter = new AntigravityAdapter({
      spawn: () => {
        const child = spawned.length === 0 ? first : second
        spawned.push(child)
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'first')
    await adapter.sendTurn(thread.id, 'second')
    expect(first.wasKilled).toBe(true)
    expect(second.wasKilled).toBe(false)
    // The replaced child's late exit must not fail the new turn.
    first.stdout.end()
    first.emit('close', null)
    await new Promise((resolve) => setImmediate(resolve))
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    await adapter.dispose()
    expect(second.wasKilled).toBe(true)
  })

  it('keeps a replaced old child silent on late error and close', async () => {
    const first = new FakeChild()
    const second = new FakeChild()
    const spawned: FakeChild[] = []
    const adapter = new AntigravityAdapter({
      spawn: () => {
        const child = spawned.length === 0 ? first : second
        spawned.push(child)
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'first')
    await adapter.sendTurn(thread.id, 'second')
    expect(first.wasKilled).toBe(true)
    // A late spawn failure from the replaced child must not fail any turn.
    first.emit('error', new Error('late boom'))
    first.emit('close', 1)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
    await adapter.dispose()
  })

  it('reports a live spawn failure exactly once when error is followed by close', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('/repo')
    await adapter.sendTurn(thread.id, 'Hello')
    child.emit('error', new Error('spawn ENOENT'))
    child.emit('close', 1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(events.filter((event) => event.type === 'thread.error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })
})

describe('Antigravity model list', () => {
  it('closes stdin for discovery — the CLI blocks forever on an open pipe', async () => {
    const child = new FakeChild()
    let stdinEnded = false
    child.stdin.on('finish', () => (stdinEnded = true))
    const adapter = new AntigravityAdapter({
      spawn: () => child,
    })
    const listing = adapter.listModels()
    await new Promise((resolve) => setImmediate(resolve))
    expect(stdinEnded).toBe(true)
    child.stdout.write('gemini-3.6-flash-high\n')
    child.stdout.end()
    child.emit('close', 0)
    await expect(listing).resolves.toMatchObject([{ id: 'gemini-3.6-flash-high' }])
  })

  it('times out model discovery deterministically while the tree shuts down', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const adapter = new AntigravityAdapter({
        spawn: () => child,
      })
      const pending = adapter.listModels()
      const assertion = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(15000)
      // A racing successful close must not change the latched timeout.
      child.emit('close', 0)
      await assertion
      expect(child.wasKilled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses the agy models output into base models with efforts', () => {
    const models = parseAntigravityModels(
      'Fetching available models...\n' +
        'gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n' +
        'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n' +
        'claude-sonnet-4-6\tClaude Sonnet 4.6\n' +
        'futuremodel\n',
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
      {
        id: 'futuremodel',
        displayName: 'Futuremodel',
        isDefault: false,
        reasoningEfforts: [],
      },
    ])
  })

  it('declares the print-mode capability set', () => {
    expect(ANTIGRAVITY_CAPABILITIES).toMatchObject({ steer: false, approvals: false })
  })
})
