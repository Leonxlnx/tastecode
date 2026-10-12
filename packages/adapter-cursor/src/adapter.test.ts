import { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { spawnOwned } from '@harness/proc/kill'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorAdapter, CURSOR_CAPABILITIES } from './adapter.js'
import { resetCursorIndexForTests } from './models.js'

vi.mock('@harness/proc/kill', async (original) => ({
  ...(await original<typeof import('@harness/proc/kill')>()),
  spawnOwned: vi.fn(),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  vi.mocked(spawnOwned).mockReset()
})

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
  override killed = false

  kill(): boolean {
    this.killed = true
    setImmediate(() => this.emit('exit', null))
    return true
  }
}

describe('Cursor adapter', () => {
  it('does not reuse a turn identity when a fresh instance resumes', async () => {
    const first = new CursorAdapter({ spawn: () => new FakeChild() })
    const resumed = new CursorAdapter({ spawn: () => new FakeChild() })
    try {
      const thread = await first.startThread('/repo')
      const previous = await first.sendTurn(thread.id, 'One')
      first.dispose()
      await resumed.resumeThread(thread.id, '/repo')
      expect(await resumed.sendTurn(thread.id, 'Two')).not.toBe(previous)
    } finally {
      first.dispose()
      resumed.dispose()
    }
  })

  it('starts and maps the documented stream-json wire format', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new CursorAdapter({
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo', {
      model: 'cursor-model',
      instructions: 'Answer plainly.',
    })
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })

    await adapter.sendTurn(thread.id, 'Update README')
    const fixture = readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8')
    child.stdout.end(fixture)
    await completed

    expect(args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--model',
      'cursor-model',
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nUpdate README',
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.delta', textDelta: "I'll update " }),
        expect.objectContaining({
          type: 'item.started',
          item: expect.objectContaining({ type: 'file_change', path: 'README.md' }),
        }),
        expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
      ]),
    )
  })

  it('starts the bundled node.exe on Windows so a multi-line first prompt survives', async () => {
    // cursor-agent.cmd forwards its arguments through cmd.exe, which cannot
    // carry the line breaks every first prompt has. The node.exe the shim
    // itself starts takes them through native argv quoting.
    const localAppData = mkdtempSync(path.join(tmpdir(), 'cursor-launch-'))
    const version = path.join(localAppData, 'cursor-agent', 'versions', '2026.07.23-e383d2b')
    mkdirSync(version, { recursive: true })
    writeFileSync(path.join(version, 'node.exe'), '')
    writeFileSync(path.join(version, 'index.js'), '')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.stubEnv('LOCALAPPDATA', localAppData)
    vi.mocked(spawnOwned).mockImplementation(() => new FakeChild())
    const adapter = new CursorAdapter()
    try {
      const thread = await adapter.startThread('C:\\repo', { instructions: 'Answer plainly.' })
      await adapter.sendTurn(thread.id, 'line one\nline two')

      expect(spawnOwned).toHaveBeenCalledWith(
        path.join(version, 'node.exe'),
        [
          path.join(version, 'index.js'),
          '--print',
          '--output-format',
          'stream-json',
          '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nline one\nline two',
        ],
        expect.objectContaining({ cwd: 'C:\\repo' }),
      )
      expect(vi.mocked(spawnOwned).mock.calls[0]?.[2]).not.toHaveProperty(
        'windowsVerbatimArguments',
      )
    } finally {
      await adapter.dispose()
      rmSync(localAppData, { recursive: true, force: true })
    }
  })

  it('keeps the session instructions for the next turn when the CLI cannot start', async () => {
    const prompts: string[] = []
    let attempts = 0
    const adapter = new CursorAdapter({
      spawn: (_command, args) => {
        attempts += 1
        if (attempts === 1) throw new Error('spawn failed')
        prompts.push(args.at(-1)!)
        return new FakeChild()
      },
    })
    const thread = await adapter.startThread('C:\\repo', { instructions: 'Answer plainly.' })

    await expect(adapter.sendTurn(thread.id, 'first')).rejects.toThrow('spawn failed')
    await adapter.sendTurn(thread.id, 'retry')

    expect(prompts).toEqual([
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nretry',
    ])
    adapter.dispose()
  })

  it('resumes, force-maps trusted modes and interrupts honestly', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new CursorAdapter({
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.resumeThread('cursor-session-1', 'C:\\repo', {
      approval: 'full',
    })

    await adapter.sendTurn(thread.id, 'Continue')
    await adapter.interrupt()

    expect(args).toContain('--force')
    expect(args).toContain('--resume')
    expect(args).toContain('session-1')
    expect(child.killed).toBe(true)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn.completed', status: 'interrupted' }),
    )
    expect(adapter.capabilities).toEqual(CURSOR_CAPABILITIES)
  })

  it('lists concrete account models without the automatic route', async () => {
    const adapter = new CursorAdapter({
      run: async (command, args) => {
        expect([command, args]).toEqual(['cursor-agent', ['models']])
        return {
          code: 0,
          stdout: [
            'Available models',
            '',
            'auto - Automatic',
            'composer-2.5 - Composer 2.5 Fast (current, default)',
            'claude-4.6-sonnet - Claude 4.6 Sonnet',
            '',
            'Tip: use --model <id> to switch.',
          ].join('\n'),
        }
      },
    })

    await expect(adapter.listModels()).resolves.toEqual([
      {
        id: 'composer-2.5',
        displayName: 'Composer 2.5 Fast',
        isDefault: true,
        reasoningEfforts: [],
        serviceTiers: [],
      },
      {
        id: 'claude-4.6-sonnet',
        displayName: 'Claude 4.6 Sonnet',
        isDefault: false,
        reasoningEfforts: [],
        serviceTiers: [],
      },
    ])
  })

  it('completes a turn whose result rides the final unterminated chunk', async () => {
    // cursor-agent writes its result line and exits immediately. The exit
    // races the stdout flush; failing on 'exit' (the pre-fix behavior)
    // reported this successful turn as a crash.
    const child = new FakeChild()
    const adapter = new CursorAdapter({
      spawn: () => child,
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'go')

    // No trailing newline — the process died mid-write of its last byte.
    child.stdout.end(
      '{"type":"result","subtype":"success","duration_ms":1,"duration_api_ms":1,"is_error":false,"result":"done","session_id":"s1"}',
    )
    await new Promise((resolve) => setImmediate(resolve))
    child.emit('exit', 0)
    child.emit('close', 0)
    await new Promise((resolve) => setImmediate(resolve))

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
  })

  it('keeps the turn alive past a frame it cannot read', async () => {
    const child = new FakeChild()
    const adapter = new CursorAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    const logs: string[] = []
    adapter.on('event', (event) => events.push(event))
    adapter.on('log', (line: string) => logs.push(line))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'go')

    // `message: null` fails the schema; the frame after it is still read.
    const drained = new Promise<void>((resolve) => child.stdout.once('end', resolve))
    child.stdout.end(
      [
        '{"type":"assistant","message":null}',
        '{"type":"result","subtype":"success","duration_ms":1,"is_error":false,"result":"done","session_id":"s1"}',
      ].join('\n'),
    )
    await drained

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    expect(logs.some((line) => line.startsWith('Cursor event handling failed'))).toBe(true)
    expect(child.killed).toBe(false)
    adapter.dispose()
  })

  it('logs a throwing event listener instead of failing the turn', async () => {
    const child = new FakeChild()
    const adapter = new CursorAdapter({ spawn: () => child })
    const events: DomainEvent[] = []
    const logs: string[] = []
    let thrown = false
    adapter.on('event', (event) => {
      events.push(event)
      if (event.type === 'item.started' && !thrown) {
        thrown = true
        throw new Error('listener failed')
      }
    })
    adapter.on('log', (line: string) => logs.push(line))
    const thread = await adapter.startThread('C:\\repo')
    const turnId = await adapter.sendTurn(thread.id, 'go')

    const drained = new Promise<void>((resolve) => child.stdout.once('end', resolve))
    child.stdout.end(
      [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":" there"}]}}',
        '{"type":"result","subtype":"success","duration_ms":1,"is_error":false,"result":"done","session_id":"s1"}',
      ].join('\n'),
    )
    await drained

    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId, status: 'completed' },
    ])
    expect(logs.some((line) => line.includes('listener failed'))).toBe(true)
    expect(child.killed).toBe(false)
    adapter.dispose()
  })

  it('lets the next turn start while the finished process is still exiting', async () => {
    const children: FakeChild[] = []
    const adapter = new CursorAdapter({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo')
    await adapter.sendTurn(thread.id, 'first')

    // The result arrives, but the process lingers: no exit/close yet.
    children[0]!.stdout.write(
      '{"type":"result","subtype":"success","duration_ms":1,"duration_api_ms":1,"is_error":false,"result":"done","session_id":"s1"}\n',
    )
    await new Promise((resolve) => setImmediate(resolve))

    // Pre-fix this threw 'a turn is already running' and the queued prompt
    // stalled forever. Now the lingering child is reaped and turn 2 starts.
    await adapter.sendTurn(thread.id, 'second')
    expect(children).toHaveLength(2)
    expect(children[0]!.killed).toBe(true)

    // The old child's close must not fail the new live turn.
    children[0]!.emit('close', 0)
    await new Promise((resolve) => setImmediate(resolve))
    expect(events.some((event) => event.type === 'thread.error')).toBe(false)
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(2)
  })

  it('rejects capabilities the CLI cannot provide', async () => {
    const adapter = new CursorAdapter()
    await expect(adapter.startThread('C:\\repo', { approval: 'auto-review' })).rejects.toThrow(
      'automatic approval review',
    )
  })

  it('applies a per-turn effort and tier using the concrete variant id', async () => {
    const capture = readFileSync(
      new URL('./fixtures/cursor-models-2026-08-07.txt', import.meta.url),
      'utf8',
    )
    resetCursorIndexForTests()
    const child = new FakeChild()
    let args: string[] = []
    let listings = 0
    const adapter = new CursorAdapter({
      run: async () => {
        listings += 1
        return { code: 0, stdout: capture, stderr: '' }
      },
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const thread = await adapter.startThread('C:\\repo', {
      model: 'gpt-5.3-codex',
      effort: 'low',
      serviceTier: 'standard',
    })
    await adapter.sendTurn(thread.id, 'go', [], {
      model: 'gpt-5.3-codex',
      effort: 'xhigh',
      serviceTier: 'fast',
    })

    // A cold index costs exactly one listing run at session start.
    expect(listings).toBe(1)
    expect(args).toContain('gpt-5.3-codex-xhigh-fast')
    adapter.dispose()
  })

  it('passes a defaults-only selection through without a listing run', async () => {
    resetCursorIndexForTests()
    const child = new FakeChild()
    let args: string[] = []
    let listings = 0
    const adapter = new CursorAdapter({
      run: async () => {
        listings += 1
        return { code: 0, stdout: '', stderr: '' }
      },
      spawn: (_command, value) => {
        args = value
        return child
      },
    })
    const thread = await adapter.startThread('C:\\repo', { model: 'gpt-5.3-codex' })
    await adapter.sendTurn(thread.id, 'go')

    expect(listings).toBe(0)
    expect(args).toContain('gpt-5.3-codex')
    adapter.dispose()
  })
})
