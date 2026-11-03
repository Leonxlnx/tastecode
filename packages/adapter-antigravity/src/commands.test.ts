import { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityAdapter, antigravityBackgroundNote } from './adapter.js'
import { agyCommandName, isAgyAnsweredCommand, listAntigravityCommands } from './commands.js'

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
    setImmediate(() => this.finish(''))
    return true
  }

  finish(stdout: string): void {
    this.stdout.end(stdout)
    this.stderr.end()
    setImmediate(() => this.emit('close', 0))
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agy-commands-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, ...file.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

function adapterWith(children: FakeChild[], calls: string[][]) {
  const adapter = new AntigravityAdapter({
    spawn: ((_command: string, args: string[]) => {
      calls.push(args)
      const child = new FakeChild()
      children.push(child)
      return child
    }) as never,
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
  return { adapter, events, turnEnded }
}

describe('Antigravity commands', () => {
  it('reads a leading command name, never a path', () => {
    expect(agyCommandName('/quota')).toBe('quota')
    expect(agyCommandName('/my-skill review this\nmore')).toBe('my-skill')
    expect(agyCommandName('/usr/bin is empty')).toBeUndefined()
    expect(isAgyAnsweredCommand('/Credits')).toBe(true)
    expect(isAgyAnsweredCommand('/clear')).toBe(false)
  })

  it('lists the answered commands and the skills /name runs', async () => {
    const project = tree({
      '.agents/skills/review/SKILL.md': '---\nname: review\ndescription: Review a diff\n---\n',
      '_agents/skills/folder-name/SKILL.md': '---\ndescription: "No name key"\n---\n',
      '.agents/skills/quiet/SKILL.md': '---\nname: quiet\ndisable-slash-command: true\n---\n',
      '.agents/skills/no-file/notes.md': 'not a skill',
    })
    const home = tree({
      '.gemini/config/skills/review/SKILL.md': '---\nname: review\ndescription: Global\n---\n',
      '.gemini/config/skills/deploy/SKILL.md': '---\nname: deploy\n---\n',
    })
    const commands = await listAntigravityCommands(project, { home })
    expect(commands.filter((command) => command.source === 'builtin')).toHaveLength(11)
    expect(commands.filter((command) => command.kind === 'skill')).toEqual([
      { name: 'review', description: 'Review a diff', kind: 'skill', source: 'custom' },
      { name: 'folder-name', description: 'No name key', kind: 'skill', source: 'custom' },
      { name: 'deploy', description: '', kind: 'skill', source: 'custom' },
    ])
  })

  it('shows an answered command as a reply and keeps the conversation and instructions', async () => {
    const children: FakeChild[] = []
    const calls: string[][] = []
    const { adapter, events, turnEnded } = adapterWith(children, calls)
    const thread = await adapter.startThread('C:\\repo', { instructions: 'Answer plainly.' })

    let ended = turnEnded()
    await adapter.sendTurn(thread.id, '/usage')
    // The JSON object agy 1.4.7 printed for -p "/usage" --output-format json.
    children[0]!.finish(
      readFileSync(new URL('./fixtures/agy-usage-1.4.7.json', import.meta.url), 'utf8'),
    )
    await ended

    ended = turnEnded()
    await adapter.sendTurn(thread.id, '/review the last commit')
    children[1]!.finish(
      '{"event":"init","conversation_id":"c-1"}\n{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"Reviewed."}}\n',
    )
    await ended

    ended = turnEnded()
    await adapter.sendTurn(thread.id, 'Thanks')
    children[2]!.finish(
      '{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"Ok."}}\n',
    )
    await ended

    expect(calls[0]).toEqual(['-p', '/usage', '--output-format', 'json'])
    expect(calls[1]!.slice(0, 2)).toEqual(['-p', '/review the last commit'])
    expect(calls[1]).not.toContain('--conversation')
    expect(calls[2]!.slice(0, 2)).toEqual([
      '-p',
      `<system-instructions>\nAnswer plainly.\n\n${antigravityBackgroundNote()}\n</system-instructions>\n\nThanks`,
    ])
    expect(calls[2]!.slice(-2)).toEqual(['--conversation', 'c-1'])
    const replies = events.flatMap((event) =>
      event.type === 'item.completed' && event.item.type === 'message' ? [event.item.text] : [],
    )
    expect(replies[0]).toMatch(/^Gemini Models\tWeekly Limit Remaining\t100%/)
    expect(replies.slice(1)).toEqual(['Reviewed.', 'Ok.'])
    expect(
      events.flatMap((event) => (event.type === 'turn.completed' ? [event.status] : [])),
    ).toEqual(['completed', 'completed', 'completed'])
  })

  it('fails an answered command that printed no answer, without agy text', async () => {
    const children: FakeChild[] = []
    const { adapter, events, turnEnded } = adapterWith(children, [])
    const thread = await adapter.startThread('C:\\repo')
    const ended = turnEnded()
    await adapter.sendTurn(thread.id, '/credits')
    children[0]!.finish('Error: signed out as someone@example.com\n')
    await ended
    expect(events.filter((event) => event.type !== 'turn.started')).toEqual([
      {
        type: 'thread.error',
        threadId: thread.id,
        message: 'Antigravity did not answer /credits.',
      },
      expect.objectContaining({ type: 'turn.completed', status: 'failed' }),
    ])
  })
})
