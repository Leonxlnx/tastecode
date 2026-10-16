import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_USAGE_HISTORY, readClaudeUsageHistory } from './usage-history.js'

describe('Claude Code usage history source', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads transcripts from the projects folder of the given home or CLAUDE_CONFIG_DIR', () => {
    const account = path.join(os.tmpdir(), 'claude-account')
    expect(CLAUDE_USAGE_HISTORY.root(account)).toBe(path.join(account, 'projects'))

    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(os.tmpdir(), 'claude-config'))
    expect(CLAUDE_USAGE_HISTORY.root()).toBe(path.join(os.tmpdir(), 'claude-config', 'projects'))

    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
    expect(CLAUDE_USAGE_HISTORY.root()).toBe(path.join(os.homedir(), '.claude', 'projects'))
  })

  it('lists every session transcript below the projects folder', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-claude-projects-'))
    try {
      mkdirSync(path.join(directory, 'project'))
      writeFileSync(path.join(directory, 'project', 'session.jsonl'), '{}\n')

      const archive = await CLAUDE_USAGE_HISTORY.discover(directory)
      expect(archive.available).toBe(true)
      expect(archive.files.map((file) => [path.basename(file.path), file.read])).toEqual([
        ['session.jsonl', readClaudeUsageHistory],
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
