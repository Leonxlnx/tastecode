import { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { CursorAdapter, CURSOR_CAPABILITIES } from './adapter.js'
import { resetCursorIndexForTests } from './models.js'

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
