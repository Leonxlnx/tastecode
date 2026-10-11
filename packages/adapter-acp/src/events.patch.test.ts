import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { Streamer } from './events.js'
import type { SessionUpdate } from './protocol.js'

describe('ACP reversible patches', () => {
  it.each([
    ['old\n', 'new\n'],
    ['old', 'new'],
    ['old\n', 'new'],
    ['', 'new\n'],
    ['old\n', ''],
    [null, 'new\n'],
    [null, ''],
  ])('reverses the exact before/after contents (%j -> %j)', (before, after) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'acp-patch-'))
    try {
      execFileSync('git', ['init', '--quiet', directory])
      const name = 'file with spaces.txt'
      const file = path.join(directory, name)
      writeFileSync(file, after!)
      const events = new Streamer('turn', directory).translate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: file, oldText: before, newText: after! }],
      })
      const diff = events.find((event) => event.type === 'diff.updated')
      if (diff?.type !== 'diff.updated') throw new Error('missing patch')
      // The reversed file must match byte for byte; a global core.autocrlf
      // (the default on Windows runners) would write CRLF instead.
      const apply = [
        '-c',
        'core.autocrlf=false',
        'apply',
        '--reverse',
        '--binary',
        '--recount',
        '-',
      ]
      execFileSync('git', apply, {
        cwd: directory,
        input: diff.diff,
      })
      if (before === null) expect(existsSync(file)).toBe(false)
      else expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not offer a reversible patch without both file versions', () => {
    const events = new Streamer('turn').translate({
      sessionUpdate: 'tool_call_update',
      content: [{ type: 'diff', path: 'file', newText: 'new' }],
    })
    expect(events.some((event) => event.type === 'diff.updated')).toBe(false)
  })

  const edit = (
    toolCallId: string,
    file: string,
    oldText: string | null,
    newText: string,
    status: 'pending' | 'completed' = 'completed',
  ): SessionUpdate => ({
    sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update',
    toolCallId,
    kind: 'edit',
    status,
    content: [{ type: 'diff', path: file, oldText, newText }],
  })
  const lastDiff = (events: DomainEvent[][]): string | undefined =>
    events
      .flat()
      .filter((event) => event.type === 'diff.updated')
      .map((event) => (event.type === 'diff.updated' ? event.diff : ''))
      .at(-1)

  it('publishes every file the turn edited, not just the last edit', () => {
    const streamer = new Streamer('turn', '/repo')
    const diff = lastDiff([
      streamer.translate(edit('e1', '/repo/a.ts', 'old\n', 'new\n')),
      streamer.translate(edit('e2', '/repo/b.ts', 'old\n', 'new\n')),
    ])
    expect(diff).toContain('"a/a.ts"')
    expect(diff).toContain('"a/b.ts"')
  })

  it('combines successive edits to one file into a single reversible hunk', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'acp-patch-'))
    try {
      execFileSync('git', ['init', '--quiet', directory])
      const file = path.join(directory, 'a.txt')
      const other = path.join(directory, 'b.txt')
      writeFileSync(file, 'three\n')
      writeFileSync(other, 'created\n')
      const streamer = new Streamer('turn', directory)
      const diff = lastDiff([
        streamer.translate(edit('e1', file, 'one\n', 'two\n')),
        streamer.translate(edit('e2', other, null, 'created\n')),
        streamer.translate(edit('e3', file, 'two\n', 'three\n')),
      ])
      execFileSync(
        'git',
        ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--binary', '--recount', '-'],
        { cwd: directory, input: diff },
      )
      // Undo restores the turn's starting point for both files.
      expect(readFileSync(file, 'utf8')).toBe('one\n')
      expect(existsSync(other)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not publish a proposed edit until it completes', () => {
    const streamer = new Streamer('turn', '/repo')
    const pending = streamer.translate(edit('e1', '/repo/a.ts', 'old\n', 'new\n', 'pending'))
    expect(pending.some((event) => event.type === 'diff.updated')).toBe(false)

    // The approved edit completes without repeating its content.
    const done = streamer.translate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      status: 'completed',
    })
    expect(lastDiff([done])).toContain('"a/a.ts"')
  })

  it('drops a proposed edit that is denied', () => {
    const streamer = new Streamer('turn', '/repo')
    streamer.note('e1', {
      kind: 'edit',
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'old\n', newText: 'new\n' }],
    })
    const failed = streamer.translate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      status: 'failed',
    })
    expect(failed.some((event) => event.type === 'diff.updated')).toBe(false)
    const later = streamer.translate(edit('e2', '/repo/b.ts', 'old\n', 'new\n'))
    expect(lastDiff([later])).not.toContain('a.ts')
  })

  it('publishes an approved edit described only in its permission request', () => {
    const streamer = new Streamer('turn', '/repo')
    streamer.note('e1', {
      kind: 'edit',
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'old\n', newText: 'new\n' }],
    })
    const done = streamer.translate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      status: 'completed',
    })
    expect(lastDiff([done])).toContain('"a/a.ts"')
  })
})
