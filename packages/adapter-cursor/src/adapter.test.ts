import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { CursorAdapter, CURSOR_CAPABILITIES } from './adapter.js'

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

describe('Cursor adapter', () => {
  it('starts and maps the documented stream-json wire format', async () => {
    const child = new FakeChild()
    let args: string[] = []
    const adapter = new CursorAdapter({
      spawn: (_command, value) => {
        args = value
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo', { model: 'cursor-model' })
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
      'Update README',
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
        return child as unknown as ChildProcessWithoutNullStreams
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
    await expect(adapter.listModels()).resolves.toEqual([])
  })

  it('rejects capabilities the CLI cannot provide', async () => {
    const adapter = new CursorAdapter()
    await expect(adapter.startThread('C:\\repo', { approval: 'auto-review' })).rejects.toThrow(
      'automatic approval review',
    )
  })
})
