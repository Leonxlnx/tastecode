import { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { GrokAdapter } from './adapter.js'

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
  constructor() {
    super()
    queueMicrotask(() => this.emit('spawn'))
  }

  override kill(): boolean {
    setImmediate(() => this.finish())
    return true
  }

  finish(lines: string[] = []): void {
    this.stdout.end(lines.map((line) => `${line}\n`).join(''))
    this.stderr.end()
    setImmediate(() => this.emit('close', 0))
  }
}

const END = '{"type":"end","stopReason":"end_turn","sessionId":"native-1"}'

describe('Grok slash commands in print mode', () => {
  it('sends a command alone and keeps the instructions for the next prompt', async () => {
    const children: FakeChild[] = []
    const prompts: string[] = []
    const adapter = new GrokAdapter({
      spawn: (_command, args) => {
        prompts.push(readFileSync(args[args.indexOf('--prompt-file') + 1]!, 'utf8'))
        const child = new FakeChild()
        children.push(child)
        return child
      },
    })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const turnEnded = () =>
      new Promise<void>((resolve) => {
        const listener = (event: DomainEvent) => {
          if (event.type !== 'turn.completed') return
          adapter.off('event', listener)
          resolve()
        }
        adapter.on('event', listener)
      })
    const thread = await adapter.startThread('C:\\repo', { instructions: 'Answer plainly.' })

    let ended = turnEnded()
    await adapter.sendTurn(thread.id, '/goal Ship the release')
    // The agent's answer to a command arrives as text, like any reply.
    children[0]!.finish(['{"type":"text","data":"Goal set."}', END])
    await ended

    ended = turnEnded()
    await adapter.sendTurn(thread.id, 'Now explain it')
    children[1]!.finish(['{"type":"text","data":"Done."}', END])
    await ended

    expect(prompts).toEqual([
      '/goal Ship the release',
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nNow explain it',
    ])
    expect(
      events.flatMap((event) =>
        event.type === 'item.completed' && event.item.type === 'message' ? [event.item.text] : [],
      ),
    ).toEqual(['Goal set.', 'Done.'])
    adapter.dispose()
  })

  it('treats a path as text, so the instructions go with it', async () => {
    const prompts: string[] = []
    const adapter = new GrokAdapter({
      spawn: (_command, args) => {
        prompts.push(readFileSync(args[args.indexOf('--prompt-file') + 1]!, 'utf8'))
        return new FakeChild()
      },
    })
    const thread = await adapter.startThread('C:\\repo', { instructions: 'Answer plainly.' })
    await adapter.sendTurn(thread.id, '/usr/bin is empty')
    expect(prompts).toEqual([
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\n/usr/bin is empty',
    ])
    adapter.dispose()
  })
})
