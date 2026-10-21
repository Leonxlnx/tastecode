import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectFolder, copyClaudeSession } from './session-copy.js'

const SOURCE = 'dd489c1a-1b5d-4392-b663-d5525ee8196f'
const COPY = '9628ea7a-1922-4f86-a6a1-a11beeee1e98'

const folder = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix))

/** Records as Claude Code 2.1.306 saves them; each names the session it belongs to. */
const transcript = [
  { type: 'ai-title', aiTitle: 'Codeword', sessionId: SOURCE },
  {
    parentUuid: null,
    type: 'user',
    uuid: 'a1',
    cwd: '/repo',
    sessionId: SOURCE,
    message: { role: 'user', content: `Remember PLUM-42. "sessionId":"${SOURCE}" is quoted here.` },
  },
  { parentUuid: 'a1', type: 'assistant', uuid: 'a2', sessionId: SOURCE, message: { content: [] } },
]

describe('copying a Claude Code session', () => {
  it('writes the transcript into another config folder as a new session for the working folder', async () => {
    const from = folder('harness-claude-from-')
    const to = folder('harness-claude-to-')
    const cwd = folder('harness-claude-cwd-')
    const project = path.join(from, 'projects', '-elsewhere')
    mkdirSync(project, { recursive: true })
    const lines = [...transcript.map((record) => JSON.stringify(record)), '{"type":"user","sessi']
    writeFileSync(path.join(project, `${SOURCE}.jsonl`), `${lines.join('\n')}\n`)

    const copy = await copyClaudeSession(SOURCE, from, { configDir: to, sessionId: COPY, cwd })

    expect(copy).toBe(path.join(to, 'projects', claudeProjectFolder(cwd)!, `${COPY}.jsonl`))
    const copied = readFileSync(copy!, 'utf8').split('\n')
    expect(copied.slice(0, 3).map((line) => JSON.parse(line) as unknown)).toEqual(
      transcript.map((record) => ({ ...record, sessionId: COPY })),
    )
    // A cut-off record stays as Claude Code wrote it; the file still ends its last line.
    expect(copied.slice(3)).toEqual(['{"type":"user","sessi', ''])
    expect(readdirSync(path.dirname(copy!))).toEqual([`${COPY}.jsonl`])
  })

  it('copies nothing when the folder holds no transcript of the session', async () => {
    const to = folder('harness-claude-to-')
    await expect(
      copyClaudeSession(SOURCE, folder('harness-claude-from-'), {
        configDir: to,
        sessionId: COPY,
        cwd: to,
      }),
    ).resolves.toBeUndefined()
    expect(readdirSync(to)).toEqual([])
  })

  it('names a project folder as Claude Code does', () => {
    const cwd = folder('harness-claude-cwd-')
    mkdirSync(path.join(cwd, 'my app.v2'))
    expect(claudeProjectFolder(cwd)).toMatch(/^[A-Za-z0-9-]+$/)
    expect(claudeProjectFolder(path.join(cwd, 'my app.v2'))).toBe(
      `${claudeProjectFolder(cwd)}-my-app-v2`,
    )
    expect(claudeProjectFolder(path.join(cwd, 'x'.repeat(200)))).toBeUndefined()
  })
})
