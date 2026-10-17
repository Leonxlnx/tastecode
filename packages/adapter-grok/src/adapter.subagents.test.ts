import { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { DomainEvent, Item } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { GROK_CAPABILITIES, GrokAdapter } from './adapter.js'

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
    setImmediate(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('close', null)
    })
    return true
  }
}

/**
 * grok 1.0.62, streaming-json, --permission-mode bypassPermissions: one foreground
 * ("Count files") and one background ("Read notes") spawn_subagent call in one step, then
 * get_command_or_subagent_output for the background one. Grok printed the final answer but
 * no end frame and did not exit, so the capture ends where the turn was stopped.
 */
const SUBAGENT_STREAM = readFileSync(
  new URL('./fixtures/stream-subagent.jsonl', import.meta.url),
  'utf8',
)
/** The same CLI with --permission-mode acceptEdits: the headless run cancels the spawn. */
const CANCELLED_STREAM = readFileSync(
  new URL('./fixtures/stream-subagent-cancelled.jsonl', import.meta.url),
  'utf8',
)

const FOREGROUND = 'call-6b9c7e8b-a508-4318-a920-21f53c6eb46e-0'
const BACKGROUND = 'call-6b9c7e8b-a508-4318-a920-21f53c6eb46e-1'

function frames(stream: string): Record<string, unknown>[] {
  return stream
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function startTurn() {
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
  const thread = await adapter.startThread('C:\\repo', { approval: 'full' })
  await adapter.sendTurn(thread.id, 'Start two subagents')
  const ended = new Promise<void>((resolve) =>
    adapter.on('event', (event) => {
      if (event.type === 'turn.completed') resolve()
    }),
  )
  return { adapter, child: children[0]!, events, ended }
}

/** The newest version of every item, in the order they first appeared. */
function finalItems(events: DomainEvent[]): Item[] {
  const items = new Map<string, Item>()
  for (const event of events) {
    if (event.type === 'item.started' || event.type === 'item.completed')
      items.set(event.item.id, event.item)
  }
  return [...items.values()]
}

function write(child: FakeChild, lines: Record<string, unknown>[]) {
  for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
}

describe('Grok subagents', () => {
  it('declares live subagent progress', () => {
    expect(GROK_CAPABILITIES.subagents).toBe('progress')
  })

  it('reports both subagents on their spawn calls and keeps their own steps out', async () => {
    const { adapter, child, events, ended } = await startTurn()
    child.stdout.write(SUBAGENT_STREAM)
    await new Promise((resolve) => setImmediate(resolve))
    // Grok never sent its end frame; the user stops the turn.
    await adapter.interrupt()
    await ended

    const items = finalItems(events)
    const spawns = items.filter((item) => item.subagent)
    expect(spawns.map((item) => item.subagent)).toEqual([
      {
        id: FOREGROUND,
        name: 'general-purpose',
        description: 'Count files',
        state: 'completed',
        toolUses: 1,
        durationMs: 11961,
        summary: '3',
      },
      {
        id: BACKGROUND,
        name: 'general-purpose',
        description: 'Read notes',
        state: 'completed',
        background: true,
        toolUses: 1,
        durationMs: 5905,
        summary: 'Tiny scratch project for a subagent capture.',
      },
    ])
    expect(spawns.map((item) => item.status)).toEqual(['completed', 'completed'])

    // The subagents read notes.txt and listed the folder, thought, and answered "3" and
    // the first line. None of that is the main agent's.
    const texts = items.map((item) => item.text ?? '')
    expect(texts.some((text) => text.startsWith('Read C:\\repo\\notes.txt'))).toBe(false)
    expect(texts.some((text) => text.startsWith('Listed'))).toBe(false)
    expect(texts).not.toContain('3')
    expect(texts).not.toContain('Tiny scratch project for a subagent capture.')
    expect(texts.some((text) => text.includes('I will list the files'))).toBe(false)
    expect(items.map((item) => `${item.type}:${(item.text ?? '').split('\n', 1)[0]}`)).toEqual([
      'tool_call:spawn_subagent',
      'tool_call:spawn_subagent',
      'reasoning:I will wait for the background subagent output.',
      'tool_call:get_command_or_subagent_output',
      'message:The folder has 3 files, and notes.txt starts with “Tiny scratch project for a subagent capture.”',
    ])

    // The background result arrived after its call completed, as a later update of that call.
    const backgroundUpdates = events.filter(
      (event) => event.type === 'item.completed' && event.item.subagent?.id === BACKGROUND,
    )
    expect(
      backgroundUpdates.map((event) => (event as { item: Item }).item.subagent?.state),
    ).toEqual(['running', 'completed'])
    await adapter.dispose()
  })

  it('counts the steps of the only running subagent, at most once a second', async () => {
    const { adapter, child, events, ended } = await startTurn()
    const captured = frames(SUBAGENT_STREAM)
    const call = (id: string) =>
      captured.filter((frame) => frame.toolCallId === id && frame.type === 'tool_call')
    const spawn = call(FOREGROUND)
    const childList = captured.filter(
      (frame) => frame.type === 'tool_call' && frame.toolName === 'list_dir',
    )
    write(child, [...spawn, ...childList])
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    const progress = events.filter(
      (event) => event.type === 'item.started' && event.item.subagent?.id === FOREGROUND,
    )
    expect(progress.map((event) => (event as { item: Item }).item.subagent)).toEqual([
      { id: FOREGROUND, description: 'Count files', state: 'running' },
      {
        id: FOREGROUND,
        description: 'Count files',
        state: 'running',
        toolUses: 1,
        lastTool: 'list_dir',
      },
    ])
    expect(progress.every((event) => (event as { item: Item }).item.status === 'started')).toBe(
      true,
    )
    expect(finalItems(events).some((item) => item.text?.startsWith('Listed'))).toBe(false)

    await adapter.interrupt()
    await ended
    const settled = finalItems(events).find((item) => item.subagent?.id === FOREGROUND)
    expect(settled).toMatchObject({ status: 'failed', subagent: { state: 'interrupted' } })
    await adapter.dispose()
  })

  it('settles a background subagent the turn never collected as interrupted', async () => {
    const { adapter, child, events, ended } = await startTurn()
    const captured = frames(SUBAGENT_STREAM)
    write(
      child,
      captured.filter((frame) => frame.toolCallId === BACKGROUND),
    )
    write(child, [{ type: 'text', data: 'Started it.' }])
    write(child, [
      {
        type: 'end',
        stopReason: 'end_turn',
        sessionId: '00000000-0000-4000-8000-000000000000',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    ])
    await ended

    const background = events.filter(
      (event) => event.type === 'item.completed' && event.item.subagent?.id === BACKGROUND,
    )
    expect(background.map((event) => (event as { item: Item }).item.subagent?.state)).toEqual([
      'running',
      'interrupted',
    ])
    // With no call of the main agent open, its own text is never taken for a subagent's.
    expect(finalItems(events).at(-1)).toMatchObject({ type: 'message', text: 'Started it.' })
    await adapter.dispose()
  })

  it('fails a spawn that a headless run may not ask permission for', async () => {
    const { adapter, child, events, ended } = await startTurn()
    child.stdout.end(CANCELLED_STREAM)
    await ended

    const spawn = finalItems(events).find((item) => item.subagent)
    expect(spawn).toMatchObject({
      type: 'tool_call',
      status: 'failed',
      subagent: {
        id: 'call-3c03923b-6736-4c05-bfc8-ebabc1e748d8-0',
        name: 'design-taste:design-reviewer',
        description: 'List files count only',
        state: 'failed',
        background: true,
        summary: 'User cancelled the execution for tool `spawn_subagent`',
      },
    })
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', status: 'failed' })
    await adapter.dispose()
  })

  it('leaves a turn without subagents untouched', async () => {
    const { adapter, child, events, ended } = await startTurn()
    child.stdout.end(readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8'))
    await ended
    expect(finalItems(events).some((item) => item.subagent)).toBe(false)
    expect(finalItems(events).map((item) => item.type)).toEqual([
      'reasoning',
      'file_change',
      'message',
    ])
    await adapter.dispose()
  })
})
