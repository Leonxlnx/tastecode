import path from 'node:path'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  AntigravityAdapter,
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_RESULT_EXIT_GRACE_MS,
  antigravityBackgroundNote,
  antigravityImagePrompt,
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

/**
 * The result agy 1.4.7 prints when the conversation holds an error step, as
 * one that failed in an earlier turn does: CAPTURED_FRAMES' result with the
 * fields steps.JSONOutput fills in then (json tags read from the agy.exe
 * binary): status ERROR and that step's message in `error`. The status is
 * the same whether this turn finished (exit 0) or failed (exit 3).
 */
const ERROR_RESULT_FRAME = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: '9f1827a7-3506-4a85-add9-63182b9917a4',
    status: 'ERROR',
    response: 'MONDLICHT\n',
    error: 'UNAUTHENTICATED (code 401): Request had invalid authentication credentials.',
    duration_seconds: 4.2,
    num_turns: 1,
    usage: {
      input_tokens: 26368,
      output_tokens: 6,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 26374,
    },
  },
})
const ERROR_RESULT_TURN = [...CAPTURED_FRAMES.slice(0, -1), ERROR_RESULT_FRAME]

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

  override kill(): boolean {
    setImmediate(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('close', null)
    })
    return true
  }
}

type SpawnRecord = { command?: string; args?: string[] }

function fakeSpawn(record: SpawnRecord, child: FakeChild) {
  return (command: string, args: string[]) => {
    record.command = command
    record.args = args
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

  it('completes a turn agy finished although its result says ERROR', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    const logs: string[] = []
    adapter.on('event', (event) => events.push(event))
    adapter.on('log', (line) => logs.push(line))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Say only the word MONDLICHT.')
    for (const frame of ERROR_RESULT_TURN) child.stdout.write(`${frame}\n`)
    child.stdout.end()
    await new Promise((resolve) => setImmediate(resolve))

    // The answer is in, but the verdict is agy's exit code.
    expect(events.find((event) => event.type === 'item.completed')).toMatchObject({
      item: { id: `${turnId}-message`, status: 'completed', text: 'MONDLICHT' },
    })
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false)

    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    expect(logs.some((line) => line.includes('UNAUTHENTICATED (code 401)'))).toBe(true)
  })

  it('still fails a turn that agy exits non-zero after an ERROR result', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Hello')
    for (const frame of ERROR_RESULT_TURN) child.stdout.write(`${frame}\n`)
    child.stdout.end()
    await new Promise((resolve) => setImmediate(resolve))
    child.emit('exit', 3, null)
    child.emit('close', 3, null)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'thread.error')).toEqual([
      {
        type: 'thread.error',
        threadId: thread.id,
        message: 'Antigravity finished with status ERROR',
      },
    ])
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'failed' },
    ])
  })

  it('judges an ERROR result on the frame alone when agy does not exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const child = new FakeChild()
      const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
      const events: DomainEvent[] = []
      adapter.on('event', (event) => events.push(event))
      const thread = await adapter.startThread('C:\\repo')
      const turnId = await adapter.sendTurn(thread.id, 'Hello')
      for (const frame of ERROR_RESULT_TURN) child.stdout.write(`${frame}\n`)
      await new Promise((resolve) => setImmediate(resolve))
      expect(events.some((event) => event.type === 'turn.completed')).toBe(false)

      vi.advanceTimersByTime(ANTIGRAVITY_RESULT_EXIT_GRACE_MS)
      child.emit('exit', 0, null)
      child.emit('close', 0, null)

      expect(events.filter((event) => event.type === 'thread.error')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
        { type: 'turn.completed', turnId, status: 'failed' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes a turn stopped while agy exits after an ERROR result as interrupted', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Hello')
    for (const frame of ERROR_RESULT_TURN) child.stdout.write(`${frame}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    await adapter.interrupt()
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'interrupted' },
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
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

  it('completes a stopped turn as interrupted and closes its open message', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Hello')
    child.stdout.write(`${CAPTURED_FRAMES[2]}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    await adapter.interrupt()
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'interrupted' },
    ])
    expect(events.find((event) => event.type === 'item.completed')).toMatchObject({
      item: { id: `${turnId}-message`, status: 'failed', text: 'MOND' },
    })
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
  })

  it('reports a spawn failure once even though close follows the error', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Hello')
    child.emit('error', new Error('spawn agy ENOENT'))
    child.emit('close', -2)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'thread.error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'failed' },
    ])
  })

  it('fails an oversized frame once rather than again on exit', async () => {
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Hello')
    child.stdout.write('x'.repeat(16 * 1024 * 1024 + 1))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'thread.error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'failed' },
    ])
  })

  it('keeps the turn alive past a frame it cannot read', async () => {
    const child = new FakeChild()
    let killed = 0
    child.kill = () => {
      killed++
      return true
    }
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    const logs: string[] = []
    adapter.on('event', (event) => events.push(event))
    adapter.on('log', (line) => logs.push(line))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Hello')

    // `step_update: null` fails the schema; the frames after it are still read.
    child.stdout.write('{"event":"step_update","step_update":null}\n')
    for (const frame of CAPTURED_FRAMES.slice(2)) child.stdout.write(`${frame}\n`)
    child.stdout.end()
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    expect(logs.some((line) => line.startsWith('Antigravity event handling failed'))).toBe(true)
    expect(killed).toBe(0)
    child.emit('close', 0)
  })

  it('logs a throwing event listener instead of failing the turn', async () => {
    const child = new FakeChild()
    let killed = 0
    child.kill = () => {
      killed++
      return true
    }
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn({}, child) })
    const events: DomainEvent[] = []
    const logs: string[] = []
    let thrown = false
    adapter.on('event', (event) => {
      events.push(event)
      if (event.type === 'item.delta' && !thrown) {
        thrown = true
        throw new Error('listener failed')
      }
    })
    adapter.on('log', (line) => logs.push(line))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'Hello')

    for (const frame of CAPTURED_FRAMES) child.stdout.write(`${frame}\n`)
    child.stdout.end()
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    expect(logs.some((line) => line.includes('listener failed'))).toBe(true)
    expect(killed).toBe(0)
    child.emit('close', 0)
  })

  it('hands attached images to the agent as files it opens, not as pixels', async () => {
    expect(ANTIGRAVITY_CAPABILITIES).toMatchObject({ images: false, imageFiles: true })
    const record: SpawnRecord = {}
    const child = new FakeChild()
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn(record, child) })
    const thread = await adapter.startThread('C:\\repo')
    const image = 'C:\\Temp\\TasteCode\\attachments\\shot.png'
    await adapter.sendTurn(thread.id, 'What is wrong here?', [image])
    const prompt = record.args?.[record.args.indexOf('-p') + 1]
    // The first prompt also carries the session note in front of the request.
    expect(prompt?.endsWith(antigravityImagePrompt('What is wrong here?', [image]))).toBe(true)
    expect(prompt).toContain('What is wrong here?\n\n<attached-images>')
    expect(prompt).toContain(`- ${image}`)
    expect(record.args?.slice(record.args.indexOf('--add-dir'))).toEqual([
      '--add-dir',
      path.dirname(image),
    ])
    expect(antigravityImagePrompt('', ['a.png', 'b.png'])).toBe(
      '<attached-images>\nThe user attached these images. Open each file with your file viewer to see it before you answer.\n- a.png\n- b.png\n</attached-images>',
    )
    expect(antigravityImagePrompt('Hi', [])).toBe('Hi')
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

  it('tells agy how to leave a server running, even without session instructions', async () => {
    const record: SpawnRecord = {}
    const adapter = new AntigravityAdapter({ spawn: fakeSpawn(record, new FakeChild()) })
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'Start the site')
    const prompt = record.args?.[record.args.indexOf('-p') + 1]
    expect(prompt).toContain('<system-instructions>')
    expect(prompt).toContain(antigravityBackgroundNote('C:\\repo'))
    expect(prompt).toContain('Start the site')
  })

  it('starts a lasting server outside agy on each platform', () => {
    // agy's Windows job object ends what agy started; WMI creates outside it,
    // hidden and in the chat's folder.
    const windows = antigravityBackgroundNote("C:\\Leon's work", 'win32')
    expect(windows).toContain('Invoke-CimMethod -ClassName Win32_Process')
    expect(windows).toContain("CurrentDirectory = 'C:\\Leon''s work'")
    expect(windows).toContain('ShowWindow = [uint16]0')
    expect(windows).toContain('%TEMP%\\dev-server.log')
    expect(antigravityBackgroundNote('/work', 'darwin')).toContain('nohup ')
    expect(antigravityBackgroundNote('/work', 'darwin')).toContain('< /dev/null &')
    expect(antigravityBackgroundNote('/work', 'linux')).not.toContain('Invoke-CimMethod')
  })

  it('lets a queued turn start without stopping what the answered turn left running', async () => {
    const first = new FakeChild()
    const second = new FakeChild()
    let killed = false
    first.kill = () => {
      killed = true
      return true
    }
    const children = [first, second]
    const adapter = new AntigravityAdapter({ spawn: () => children.shift()! })
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'Start the site')
    for (const frame of CAPTURED_FRAMES) first.stdout.write(`${frame}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    // The SUCCESS result is in and agy is closing when the queued prompt starts.
    const next = adapter.sendTurn(thread.id, 'Now add a footer')
    await new Promise((resolve) => setImmediate(resolve))
    first.emit('exit', 0, null)
    await next

    expect(killed).toBe(false)
    expect(children).toEqual([])
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

  it("runs each turn with agy's auto-updater switched off", async () => {
    const child = new FakeChild()
    const seen: Array<NodeJS.ProcessEnv> = []
    const adapter = new AntigravityAdapter({
      spawn: (_command, _args, options) => {
        seen.push(options.env)
        return child
      },
    })
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'Hi')

    expect(seen).toEqual([{ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }])
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

describe('bounded model discovery capture', () => {
  it.each(['stdout', 'stderr'] as const)(
    'rejects a %s flood before parsing output',
    async (stream) => {
      const child = new FakeChild()
      let killed = 0
      child.kill = () => {
        killed++
        return true
      }
      const adapter = new AntigravityAdapter({ spawn: () => child })
      const discovery = adapter.listModels()
      const rejected = expect(discovery).rejects.toThrow('CLI output exceeded the size limit')
      child[stream].write('harmless-fixture'.repeat(100_000))
      await rejected
      child[stream].write('late output')
      child.emit('close', 0)
      expect(killed).toBe(1)
    },
  )
})
