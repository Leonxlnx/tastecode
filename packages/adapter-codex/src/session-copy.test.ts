import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'
import { copyCodexThread } from './session-copy.js'

const peers = vi.hoisted(() => ({ queued: [] as FakeCodexRpc[] }))
vi.mock('@harness/proc', async (original) => ({
  ...(await original<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor() {
      const rpc = peers.queued.shift()
      if (!rpc) throw new Error('unexpected Codex process')
      return rpc
    }
  },
}))

afterEach(() => {
  peers.queued = []
})

const PARENT = '01a15b8f-02d0-7013-abe3-32abbee86ce1'
const CHILD = '01a16005-e294-7f41-8e12-6a923f1a6c1f'

/** A rollout as Codex 0.163 saves it: metadata first, a fork naming the thread it came from. */
function saveRollout(home: string, day: string, threadId: string, forkedFrom?: string): string {
  const folder = path.join(home, 'sessions', ...day.split('/'))
  mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `rollout-${day.replaceAll('/', '-')}T10-00-00-${threadId}.jsonl`)
  const meta = {
    type: 'session_meta',
    payload: {
      id: threadId,
      ...(forkedFrom ? { forked_from_id: forkedFrom, forked_from_ordinal_exclusive: 4 } : {}),
    },
  }
  writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"event_msg","payload":{}}\n`)
  return file
}

const home = () => mkdtempSync(path.join(tmpdir(), 'harness-codex-home-'))

describe('carrying a Codex thread to another home', () => {
  it('copies the thread with the threads it was forked from, at the same places', async () => {
    const from = home()
    const to = home()
    const parent = saveRollout(from, '2026/10/20', PARENT)
    const child = saveRollout(from, '2026/10/21', CHILD, PARENT)

    expect(await copyCodexThread(CHILD, from, to)).toEqual([CHILD, PARENT])
    for (const file of [parent, child]) {
      const copy = path.join(to, path.relative(from, file))
      expect(readFileSync(copy, 'utf8')).toBe(readFileSync(file, 'utf8'))
    }
  })

  it('carries nothing when the thread or one it descends from is missing', async () => {
    const from = home()
    const to = home()
    saveRollout(from, '2026/10/21', CHILD, PARENT)

    expect(await copyCodexThread(PARENT, from, to)).toBeUndefined()
    expect(await copyCodexThread(CHILD, from, to)).toBeUndefined()
  })

  it('finds the thread in place when it stays in the same home', async () => {
    const same = home()
    saveRollout(same, '2026/10/21', PARENT)

    expect(await copyCodexThread(PARENT, same, same)).toEqual([PARENT])
  })
})

describe('Codex fork of a saved thread', () => {
  it("opens the copied thread's ancestors before it forks it with the new chat's settings", async () => {
    const from = home()
    const accountHome = home()
    saveRollout(from, '2026/10/20', PARENT)
    saveRollout(from, '2026/10/21', CHILD, PARENT)
    const rpc = new FakeCodexRpc((method, params) => {
      if (method === 'thread/resume')
        return {
          thread: { id: (params as { threadId: string }).threadId, createdAt: 1 },
          model: 'm',
        }
      if (method === 'thread/fork') return { thread: { id: 'forked' }, model: 'gpt-6.1-sol' }
      return {}
    })
    peers.queued.push(rpc)
    const adapter = new CodexAdapter({ accountHome })
    try {
      await adapter.start()
      const thread = await adapter.forkThread(
        '/repo',
        { threadId: CHILD, accountHome: from },
        { model: 'gpt-6.1-sol', instructions: 'Be brief.', approval: 'full' },
      )

      expect(thread).toMatchObject({ id: 'forked', provider: 'codex', workspacePath: '/repo' })
      expect(
        existsSync(
          path.join(
            accountHome,
            'sessions/2026/10/20',
            `rollout-2026-10-20T10-00-00-${PARENT}.jsonl`,
          ),
        ),
      ).toBe(true)
      const calls = rpc.calls.filter((call) => call.method.startsWith('thread/'))
      expect(calls.map((call) => call.method)).toEqual([
        'thread/resume',
        'thread/unsubscribe',
        'thread/fork',
      ])
      expect(calls[0]?.params).toMatchObject({ threadId: PARENT, excludeTurns: true })
      expect(calls[2]?.params).toMatchObject({
        threadId: CHILD,
        cwd: '/repo',
        model: 'gpt-6.1-sol',
        developerInstructions: 'Be brief.',
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('refuses a thread the other home has no rollout of', async () => {
    peers.queued.push(new FakeCodexRpc())
    const adapter = new CodexAdapter({ accountHome: home() })
    try {
      await adapter.start()
      await expect(
        adapter.forkThread('/repo', { threadId: PARENT, accountHome: home() }),
      ).rejects.toThrow('Codex has no saved conversation to carry on.')
    } finally {
      await adapter.dispose()
    }
  })
})
