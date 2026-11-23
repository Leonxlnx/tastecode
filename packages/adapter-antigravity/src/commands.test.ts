import { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityAdapter } from './adapter.js'
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
    // A real process reports its exit before its pipes close.
    setImmediate(() => {
      this.emit('exit', 0, null)
      this.emit('close', 0)
    })
  }
}

class FakeAcpChild extends FakeChild {
  readonly prompts: string[] = []
  #buf = ''
  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.#buf += chunk
      let nl: number
      while ((nl = this.#buf.indexOf('\n')) !== -1) {
        const line = this.#buf.slice(0, nl).trim()
        this.#buf = this.#buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line) as {
          id?: number
          method?: string
          params?: { prompt?: Array<{ text?: string }> }
        }
        if (msg.id === undefined) continue
        if (msg.method === 'initialize') {
          this.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })}\n`,
          )
        } else if (msg.method === 'session/new') {
          this.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'c-1' } })}\n`,
          )
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text ?? ''
          this.prompts.push(text)
          const reply = text.startsWith('/review') ? 'Reviewed.' : 'Ok.'
          this.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'c-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } })}\n`,
          )
          this.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n`,
          )
        } else {
          this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
        }
      }
    })
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

function adapterWith(commandChildren: FakeChild[], calls: string[][]) {
  let acpChild: FakeAcpChild | undefined
  const adapter = new AntigravityAdapter({
    spawn: ((_command: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'acp') {
        acpChild = new FakeAcpChild()
        return acpChild
      }
      const child = new FakeChild()
      commandChildren.push(child)
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
  return { adapter, events, turnEnded, getAcpChild: () => acpChild }
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

  it('shows an answered command as a reply and keeps the ACP conversation and instructions', async () => {
    const commandChildren: FakeChild[] = []
    const calls: string[][] = []
    const { adapter, events, turnEnded, getAcpChild } = adapterWith(commandChildren, calls)
    const thread = await adapter.startThread('C:\\repo', { instructions: 'Answer plainly.' })

    let ended = turnEnded()
    await adapter.sendTurn(thread.id, '/usage')
    // The JSON object agy 1.4.7 printed for -p "/usage" --output-format json.
    commandChildren[0]!.finish(
      readFileSync(new URL('./fixtures/agy-usage-1.4.7.json', import.meta.url), 'utf8'),
    )
    await ended

    ended = turnEnded()
    await adapter.sendTurn(thread.id, '/review the last commit')
    await ended

    ended = turnEnded()
    await adapter.sendTurn(thread.id, 'Thanks')
    await ended

    expect(calls[0]).toEqual(['acp'])
    expect(calls[1]).toEqual(['-p', '/usage', '--output-format', 'json'])
    expect(getAcpChild()!.prompts).toEqual([
      '/review the last commit',
      '<system-instructions>\nAnswer plainly.\n</system-instructions>\n\nThanks',
    ])
    const replies = events.flatMap((event) =>
      event.type === 'item.completed' && event.item.type === 'message' ? [event.item.text] : [],
    )
    expect(replies[0]).toMatch(/^Gemini Models\tWeekly Limit Remaining\t100%/)
    expect(replies.slice(1)).toEqual(['Reviewed.', 'Ok.'])
    expect(
      events.flatMap((event) => (event.type === 'turn.completed' ? [event.status] : [])),
    ).toEqual(['completed', 'completed', 'completed'])
    await adapter.dispose()
  })

  it('fails an answered command that printed no answer, without agy text', async () => {
    const commandChildren: FakeChild[] = []
    const { adapter, events, turnEnded } = adapterWith(commandChildren, [])
    const thread = await adapter.startThread('C:\\repo')
    const ended = turnEnded()
    await adapter.sendTurn(thread.id, '/credits')
    commandChildren[0]!.finish('Error: signed out as someone@example.com\n')
    await ended
    expect(events.filter((event) => event.type !== 'turn.started')).toEqual([
      {
        type: 'thread.error',
        threadId: thread.id,
        message: 'Antigravity did not answer /credits.',
      },
      expect.objectContaining({ type: 'turn.completed', status: 'failed' }),
    ])
    await adapter.dispose()
  })
})
