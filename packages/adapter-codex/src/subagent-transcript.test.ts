import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ItemSchema, type Item, type ProviderHistorySession } from '@harness/contracts'
import { createCodexHistorySource } from './history.js'

// Shapes from a codex 0.166 multi-agent v2 rollout of a spawned subagent, texts replaced:
// its own session_meta, then a copy of the parent's, the parent's history up to the spawn,
// and from `subagent_history_start_ordinal` on the subagent's own turn.
const child = '01a14938-3aa8-7d40-b113-7f848c86d071'
const parent = '01a14936-90eb-7c63-88ad-0dc9d0ad3bda'
const at = '2026-10-17T11:35:00.000Z'
const task = 'Read notes.txt in the current folder and reply with only its first line.'
const roots: string[] = []

const line = (ordinal: number, type: string, payload: unknown) => ({
  timestamp: at,
  ordinal,
  type,
  payload,
})
const provenance = (type: string) => ({
  turn_id: 'child-turn',
  content_item_metadata: [{ provenance: { type } }],
})
const taskContent = (payload: unknown) => [
  {
    type: 'input_text',
    text: 'Message Type: NEW_TASK\nTask name: /root/read_first_line\nSender: /root\nPayload:\n',
  },
  payload,
]

function rollout(taskPayload: unknown = { type: 'input_text', text: task }) {
  return [
    line(0, 'session_meta', {
      id: child,
      forked_from_id: parent,
      parent_thread_id: parent,
      timestamp: at,
      cwd: 'C:\\project',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parent,
            depth: 1,
            agent_path: '/root/read_first_line',
            agent_nickname: 'Locke',
            agent_role: null,
          },
        },
      },
      thread_source: 'subagent',
      agent_path: '/root/read_first_line',
      subagent_history_start_ordinal: 6,
      multi_agent_version: 'v2',
    }),
    line(1, 'session_meta', { id: parent, timestamp: at, cwd: 'C:\\project', source: 'vscode' }),
    line(2, 'event_msg', { type: 'task_started', turn_id: 'parent-turn' }),
    line(3, 'response_item', {
      type: 'message',
      id: 'parent-prompt',
      role: 'user',
      content: [{ type: 'input_text', text: 'Use a subagent to read notes.txt' }],
      internal_chat_message_metadata_passthrough: provenance('user'),
    }),
    line(4, 'response_item', {
      type: 'function_call',
      name: 'spawn_agent',
      namespace: 'collaboration',
      call_id: 'call_62a5',
      arguments: JSON.stringify({ task_name: 'read_first_line', message: task }),
    }),
    line(5, 'event_msg', { type: 'turn_aborted', turn_id: 'parent-turn', reason: 'interrupted' }),
    line(6, 'event_msg', { type: 'task_started', turn_id: 'child-turn' }),
    line(7, 'response_item', {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'private configuration' }],
    }),
    line(8, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions' }],
      internal_chat_message_metadata_passthrough: provenance('agents_md'),
    }),
    line(9, 'turn_context', { turn_id: 'child-turn', cwd: 'C:\\project', model: 'gpt-6-luna' }),
    line(10, 'inter_agent_communication_metadata', { trigger_turn: true }),
    line(11, 'response_item', {
      type: 'agent_message',
      id: 'amsg_task',
      author: '/root',
      recipient: '/root/read_first_line',
      content: taskContent(taskPayload),
    }),
    line(12, 'event_msg', {
      type: 'item_completed',
      thread_id: child,
      turn_id: 'child-turn',
      item: {
        type: 'CommandExecution',
        id: 'exec-c003',
        command: ['pwsh', '-Command', 'Get-Content notes.txt -TotalCount 1'],
        aggregated_output: 'Tiny scratch project for a subagent capture.\r\n',
        exit_code: 0,
        duration: { secs: 0, nanos: 806000000 },
      },
      started_at_ms: Date.parse(at),
    }),
    line(13, 'event_msg', {
      type: 'item_completed',
      thread_id: child,
      turn_id: 'child-turn',
      item: {
        type: 'AgentMessage',
        id: 'msg_answer',
        content: [{ type: 'Text', text: 'Tiny scratch project for a subagent capture.' }],
        phase: 'final_answer',
      },
      started_at_ms: Date.parse(at) + 1000,
    }),
    line(14, 'response_item', {
      type: 'message',
      id: 'msg_answer',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Tiny scratch project for a subagent capture.' }],
    }),
    line(15, 'event_msg', { type: 'task_complete', turn_id: 'child-turn' }),
  ]
}

async function home(records: unknown[], options: { indexed?: boolean; name?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-'))
  roots.push(root)
  const directory = path.join(root, 'sessions', '2026', '10', '17')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, options.name ?? `rollout-2026-10-17T11-35-00-${child}.jsonl`)
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  if (options.indexed) {
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(child, file)
    db.close()
  }
  return { root, file }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// The parent chat's saved session; Codex finds a subagent by its own thread id instead.
const parentSession: ProviderHistorySession = {
  id: parent,
  workspacePath: 'C:\\project',
  title: 'Parent',
  createdAt: Date.parse(at),
  updatedAt: Date.parse(at),
  revision: '',
}
const spawnRow = (subagent: Partial<NonNullable<Item['subagent']>> = {}): Item => ({
  id: 'call_62a5',
  turnId: 'parent-turn',
  type: 'tool_call',
  status: 'completed',
  text: 'Subagent started',
  createdAt: Date.parse(at),
  subagent: { id: child, state: 'completed', ...subagent },
})
const transcript = (root: string, row = spawnRow()) =>
  createCodexHistorySource({ codexHome: root }).readSubagentTranscript!(parentSession, row)

describe('a Codex subagent’s own transcript', () => {
  it('shows the task its parent sent, its work and its answer, without the parent’s copy', async () => {
    const records = rollout()
    const { root, file } = await home(records)
    const items = await transcript(root)

    for (const item of items) expect(ItemSchema.safeParse(item).success).toBe(true)
    expect(items.map(({ type, role, text }) => ({ type, role, text }))).toEqual([
      { type: 'message', role: 'user', text: task },
      {
        type: 'command',
        role: undefined,
        text: 'Tiny scratch project for a subagent capture.\r\n',
      },
      {
        type: 'message',
        role: 'assistant',
        text: 'Tiny scratch project for a subagent capture.',
      },
    ])
    expect(items[0]).toMatchObject({ id: 'amsg_task', turnId: 'child-turn' })
    expect(items[1]).toMatchObject({ exitCode: 0, durationMs: 806 })
    expect(items[2]).toMatchObject({ id: 'msg_answer', phase: 'final_answer' })
    // Reading never changes Codex's own file.
    expect(await readFile(file, 'utf8')).toBe(
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    )
  })

  it('keeps the plain notice of a task Codex stored encrypted', async () => {
    const { root } = await home(
      rollout({ type: 'encrypted_content', encrypted_content: 'gAAAAABopaque' }),
    )
    const items = await transcript(root)
    expect(items.filter((item) => item.role === 'user')).toEqual([])
    expect(items[0]).toMatchObject({
      type: 'tool_call',
      text: expect.stringContaining('Message Type: NEW_TASK'),
    })
    expect(items.at(-1)?.text).toBe('Tiny scratch project for a subagent capture.')
  })

  it('reads a rollout without a start mark whole', async () => {
    const records = rollout().filter((record) => record.ordinal === 0 || record.ordinal >= 6)
    const meta = records[0]!.payload as Record<string, unknown>
    delete meta['subagent_history_start_ordinal']
    const { root } = await home(records)
    const items = await transcript(root)
    expect(items.map((item) => item.text)).toEqual([
      task,
      'Tiny scratch project for a subagent capture.\r\n',
      'Tiny scratch project for a subagent capture.',
    ])
  })

  it('finds the rollout through Codex’s state index', async () => {
    // A name without the thread id proves the index, not the search, found it.
    const { root } = await home(rollout(), { indexed: true, name: 'rollout-indexed.jsonl' })
    const items = await transcript(root)
    expect(items.at(-1)?.text).toBe('Tiny scratch project for a subagent capture.')
  })

  it('opens nothing outside Codex’s session folders', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'codex-outside-'))
    roots.push(outside)
    const stray = path.join(outside, `rollout-${child}.jsonl`)
    await writeFile(
      stray,
      rollout()
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    )
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-'))
    roots.push(root)
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(child, stray)
    db.close()

    expect(await transcript(root)).toEqual([])
    expect(await transcript(root, spawnRow({ id: '../../etc/passwd' }))).toEqual([])
    expect(
      await transcript(root, spawnRow({ id: '01a14938-0000-7000-8000-000000000000' })),
    ).toEqual([])
  })

  it('answers an unchanged rollout from memory and re-reads it once it grows', async () => {
    const records = rollout()
    const { root, file } = await home(records)
    const first = await transcript(root)
    expect(await transcript(root)).toEqual(first)

    const more = [
      line(16, 'event_msg', { type: 'task_started', turn_id: 'child-turn-2' }),
      line(17, 'response_item', {
        type: 'agent_message',
        id: 'amsg_more',
        author: '/root',
        recipient: '/root/read_first_line',
        content: taskContent({ type: 'input_text', text: 'Now the second line.' }),
      }),
      line(18, 'event_msg', { type: 'task_complete', turn_id: 'child-turn-2' }),
    ]
    await writeFile(file, [...records, ...more].map((record) => JSON.stringify(record)).join('\n'))
    const second = await transcript(root)
    expect(second.slice(0, first.length)).toEqual(first)
    expect(second.at(-1)).toMatchObject({ role: 'user', text: 'Now the second line.' })
  })

  it('replaces a screenshot’s inline data with a short note', async () => {
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
    const records = [
      ...rollout(),
      line(16, 'event_msg', { type: 'task_started', turn_id: 'child-turn-2' }),
      line(17, 'response_item', {
        type: 'message',
        id: 'msg_shot',
        role: 'user',
        content: [
          { type: 'input_text', text: 'The page now:' },
          { type: 'input_image', image_url: image },
          { type: 'input_image', image_url: 'C:\\project\\shot.png' },
        ],
        internal_chat_message_metadata_passthrough: provenance('user'),
      }),
      line(18, 'event_msg', { type: 'task_complete', turn_id: 'child-turn-2' }),
    ]
    const { root } = await home(records)
    const items = await transcript(root)
    const shot = items.find((item) => item.id === 'msg_shot')
    expect(shot).toMatchObject({
      text: 'The page now:\n[Screenshot]',
      attachments: ['C:\\project\\shot.png'],
    })
    expect(JSON.stringify(items)).not.toContain('base64')
  })

  it('reads by the provider reference when the row carries one', async () => {
    const { root } = await home(rollout())
    const other = '01a14938-0000-7000-8000-000000000000'
    const items = await transcript(root, spawnRow({ id: other, transcriptId: child }))
    expect(items.at(-1)?.text).toBe('Tiny scratch project for a subagent capture.')
    const { subagent: _none, ...plainRow } = spawnRow()
    expect(await transcript(root, plainRow)).toEqual([])
  })
})
