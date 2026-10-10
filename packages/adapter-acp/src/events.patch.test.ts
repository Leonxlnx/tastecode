import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Streamer } from './events.js'

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
      execFileSync('git', ['-C', directory, 'config', 'core.autocrlf', 'false'])
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
      execFileSync('git', ['apply', '--reverse', '--binary', '--recount', '-'], {
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
})
