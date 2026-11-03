import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ItemSchema, type Item, type ProviderHistorySession } from '@harness/contracts'
import { canCreateSymlinks } from '@harness/proc/symlink.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import { createClaudeHistorySource } from './history.js'
import { contentBlocks, object, type SavedRecord } from './history-items.js'

const SESSION = 'ff4ab293-d6bc-45e9-a7c5-8cf7e348a239'
const FOREGROUND = 'a07e72187d97f2b90'
const BACKGROUND = 'ad5eb828797c51a09'
const SPAWN = 'toolu_013q1DPbqKe2X5zc1rEpXizW'
const canSymlink = canCreateSymlinks()
const directories: string[] = []
const captured = (
  await readFile(new URL('./fixtures/subagent-claude-2.1.296.jsonl', import.meta.url), 'utf8')
)
  .split('\n')
  .filter(Boolean)
  .map((line) => object(object(JSON.parse(line)).message))
  .filter((row) => row.type === 'user' || row.type === 'assistant')

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** SDK payloads replayed in the saved layout exercised by history.test.ts, not a new capture. */
function saved(rows: SavedRecord[], agentId?: string): SavedRecord[] {
  return rows.map((row, index) => ({
    type: row.type,
    uuid: row.uuid,
    parentUuid: rows[index - 1]?.uuid ?? null,
    timestamp: row.timestamp ?? '2026-10-17T09:29:52.000Z',
    sessionId: SESSION,
    cwd: 'C:\\project',
    message: row.message,
    toolUseResult: row.tool_use_result,
    ...(agentId ? { isSidechain: true, agentId } : {}),
  }))
}

async function fixture() {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-subagent-'))
  directories.push(configDir)
  const project = path.join(configDir, 'projects', '-fixture')
  const folder = path.join(project, SESSION, 'subagents')
  await mkdir(folder, { recursive: true })
  const main = saved(captured.filter((row) => !row.parent_tool_use_id))
  await writeFile(
    path.join(project, `${SESSION}.jsonl`),
    main.map((row) => JSON.stringify(row)).join('\n'),
  )
  const launch = captured.flatMap(contentBlocks).find((block) => block.id === SPAWN)!
  const prompt = object(launch.input).prompt
  const side = saved(
    [
      { type: 'user', uuid: 'prompt', message: { role: 'user', content: prompt } },
      ...captured.filter((row) => row.agent_id === BACKGROUND),
    ],
    BACKGROUND,
  )
  const file = path.join(folder, `agent-${BACKGROUND}.jsonl`)
  await writeFile(file, side.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const source = createClaudeHistorySource({ configDir })
  const session: ProviderHistorySession = {
    id: SESSION,
    workspacePath: 'C:\\project',
    title: 'Start agents',
    revision: '',
    createdAt: Date.parse('2026-10-17T09:29:52.000Z'),
    updatedAt: Date.parse('2026-10-17T09:29:57.104Z'),
  }
  const item: Item = {
    id: `${SPAWN}-call`,
    turnId: 'main-turn',
    type: 'tool_call',
    status: 'completed',
    createdAt: session.createdAt,
    subagent: { id: SPAWN, state: 'completed', transcriptId: BACKGROUND },
  }
  const read = (selected = item) => source.readSubagentTranscript!(session, selected)
  return { configDir, project, folder, file, side, source, session, item, read, prompt }
}

describe('Claude subagent history', () => {
  it('reads the captured prompt, tool input/output and full answer without a history scan', async () => {
    const f = await fixture()
    const items = await f.read()
    expect(items).toHaveLength(3)
    items.forEach((item) => expect(ItemSchema.safeParse(item).success).toBe(true))
    expect(items[0]).toMatchObject({ type: 'message', role: 'user', text: f.prompt })
    expect(items[1]).toMatchObject({
      type: 'tool_call',
      status: 'completed',
      text: expect.stringContaining('Read\n{"file_path":"C:\\\\project\\\\notes.txt","limit":1}'),
    })
    expect(items[1]?.text).toContain('1\tTiny scratch project for a subagent capture.')
    expect(items[2]).toMatchObject({
      type: 'message',
      role: 'assistant',
      text: 'Tiny scratch project for a subagent capture.',
    })
    expect(await f.read()).toEqual(items)
  })

  it('resolves old snapshots through the parent tool result and keeps other agents out', async () => {
    const f = await fixture()
    const foreground = captured.filter((row) => row.agent_id === FOREGROUND)
    await writeFile(
      path.join(f.folder, `agent-${FOREGROUND}.jsonl`),
      saved(foreground, FOREGROUND)
        .map((row) => JSON.stringify(row))
        .join('\n'),
    )
    // Metadata from versions that did not record the spawning call leaves the parent's result.
    await writeFile(
      path.join(f.folder, `agent-${FOREGROUND}.meta.json`),
      JSON.stringify({ agentType: 'Explore', description: 'Count files' }),
    )
    const items = await f.read({
      ...f.item,
      subagent: { id: 'toolu_01H2ohrcMYG9HG3ePSQ7yz9z', state: 'completed' },
    })
    expect(items[0]?.text).toBe(
      'Use Glob to list the files in the current folder and reply with only the number of files.',
    )
    expect(items[1]?.text).toContain('Glob\n{"pattern":"*"}')
    expect(items[1]?.text).toContain('notes.txt\nhello.js\nREADME.md')
    expect(items.some((item) => item.text?.startsWith('Read\n'))).toBe(false)
  })

  it('finds an old snapshot through sidechain metadata without the parent result', async () => {
    const f = await fixture()
    const foreground = captured.filter((row) => row.agent_id === FOREGROUND)
    await writeFile(
      path.join(f.folder, `agent-${FOREGROUND}.jsonl`),
      saved(foreground, FOREGROUND)
        .map((row) => JSON.stringify(row))
        .join('\n'),
    )
    const spawn = 'toolu_01H2ohrcMYG9HG3ePSQ7yz9z'
    await writeFile(
      path.join(f.folder, `agent-${FOREGROUND}.meta.json`),
      JSON.stringify({ agentType: 'Explore', toolUseId: spawn }),
    )
    await writeFile(
      path.join(f.folder, `agent-${BACKGROUND}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', toolUseId: SPAWN }),
    )
    await writeFile(path.join(f.folder, 'agent-broken.meta.json'), '{')
    // Only the first parent row stays: no saved tool result names either agent.
    const parent = path.join(f.project, `${SESSION}.jsonl`)
    await writeFile(parent, (await readFile(parent, 'utf8')).split('\n')[0]!)
    const items = await f.read({ ...f.item, subagent: { id: spawn, state: 'completed' } })
    expect(items[1]?.text).toContain('Glob\n{"pattern":"*"}')
    const background = await f.read({ ...f.item, subagent: { id: SPAWN, state: 'completed' } })
    expect(background.at(-1)?.text).toBe('Tiny scratch project for a subagent capture.')
  })

  it('answers an unchanged sidechain from memory and reads on when it grows', async () => {
    const f = await fixture()
    const first = await f.read()
    expect(await f.read()).toBe(first)
    const more = 'Read once more.'
    await appendFile(
      f.file,
      JSON.stringify({
        ...f.side.at(-1),
        uuid: 'later',
        parentUuid: f.side.at(-1)!.uuid,
        message: { role: 'assistant', content: [{ type: 'text', text: more }] },
      }) + '\n',
    )
    const grown = await f.read()
    expect(grown.slice(0, first.length)).toEqual(first)
    expect(grown.at(-1)).toMatchObject({ role: 'assistant', text: more })
    // A rewritten file is read again from its first byte.
    await writeFile(f.file, JSON.stringify(f.side[0]) + '\n')
    expect(await f.read()).toEqual([first[0]])
  })

  it('replaces inline images and files with short placeholders', async () => {
    const f = await fixture()
    const png = Buffer.alloc(200_000)
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png)
    png.writeUInt32BE(1280, 16)
    png.writeUInt32BE(800, 20)
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, ...app0, ...sof]), Buffer.alloc(1000)])
    const image = (mediaType: string, data: Buffer) => ({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
    })
    const shot = image('image/png', png)
    const result = f.side[2]!
    f.side[2] = {
      ...result,
      toolUseResult: { content: [shot], durationMs: 12 },
      message: {
        role: 'user',
        content: contentBlocks(result).map((block) => ({
          ...block,
          content: [
            { type: 'text', text: 'Captured the page.' },
            shot,
            image('image/jpeg', jpeg),
            image('image/webp', Buffer.from('not an image')),
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
            },
          ],
        })),
      },
    }
    await writeFile(f.file, f.side.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const items = await f.read()
    const tool = items.find((item) => item.type === 'tool_call')!
    expect(tool.text).toContain(
      'Captured the page.\n[Screenshot 1280×800]\n[Screenshot 640×480]\n[Screenshot]\n[Attached file]',
    )
    expect(tool.attachments).toBeUndefined()
    expect(tool.durationMs).toBe(12)
    const sent = JSON.stringify(items)
    expect(sent).not.toContain('base64')
    expect(sent).not.toContain(png.toString('base64').slice(0, 40))
    expect(sent).not.toContain('data:')
  })

  it('keeps answers longer than the snapshot summary limit', async () => {
    const f = await fixture()
    const answer = 'The complete subagent answer.\n'.repeat(100)
    f.side.at(-1)!.message = { role: 'assistant', content: [{ type: 'text', text: answer }] }
    await writeFile(f.file, f.side.map((row) => JSON.stringify(row)).join('\n'))
    expect((await f.read()).at(-1)?.text).toBe(answer)
  })

  it('tolerates a partial final write and preserves failed tool results', async () => {
    const f = await fixture()
    const result = f.side[2]!
    const failed = {
      ...result,
      message: {
        role: 'user',
        content: contentBlocks(result).map((block) => ({ ...block, is_error: true })),
      },
    }
    await writeFile(
      f.file,
      [f.side[0], f.side[1], failed].map((row) => JSON.stringify(row)).join('\n') + '\n',
    )
    await appendFile(f.file, '{"type":"assistant"')
    const items = await f.read()
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ status: 'failed', text: expect.stringContaining('1\tTiny') })
  })

  it('returns no transcript for missing, malformed or traversing references', async () => {
    const f = await fixture()
    for (const transcriptId of ['missing', '../outside', '..\\outside', '/outside']) {
      expect(await f.read({ ...f.item, subagent: { ...f.item.subagent!, transcriptId } })).toEqual(
        [],
      )
    }
    expect(await f.read({ ...f.item, subagent: { id: 'unknown', state: 'completed' } })).toEqual([])
    await writeFile(f.file, 'not json\n{}\n')
    expect(await f.read()).toEqual([])
  })

  it.skipIf(!canSymlink)('refuses a sidechain symlink outside the parent session', async () => {
    const f = await fixture()
    const outside = path.join(f.configDir, 'outside.jsonl')
    await writeFile(outside, f.side.map((row) => JSON.stringify(row)).join('\n'))
    await rm(f.file)
    await symlink(outside, f.file)
    expect(await f.read()).toEqual([])
  })
})
