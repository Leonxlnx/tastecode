import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession, ProviderRuntime } from './adapters.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'
import { McpConfigStore } from './mcp-config.js'
import { ModelConnectionStore } from './model-connections.js'
import { CustomHarnessStore } from './custom-harnesses.js'
import { retainCheckpoint, takeSnapshot } from './checkpoint.js'
import { runHistoryCli } from './history-cli.js'

const roots: string[] = []
const active: Array<{ orchestrator: Orchestrator; store: Store }> = []
function gate() {
  let release!: () => void
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve
    }),
    release: () => release(),
  }
}
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-audit-regression-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(path.join(repo, 'app.txt'), 'main\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'main')
  git(repo, 'switch', '-c', 'other')
  writeFileSync(path.join(repo, 'app.txt'), 'other\n')
  git(repo, 'commit', '-qam', 'other')
  git(repo, 'switch', 'main')
  return { root, repo }
}
class Session implements AgentSession {
  capabilities = {
    steer: false,
    fork: false,
    interrupt: true,
    reasoningItems: false,
    approvals: false,
    images: true,
  }
  sent = 0
  stopped = false
  stopGate: ReturnType<typeof gate> | undefined
  stopError: Error | undefined
  async sendTurn() {
    this.sent += 1
    return 'turn'
  }
  async interrupt() {}
  respondToApproval() {}
  on() {}
  async dispose() {
    await this.stopGate?.promise
    if (this.stopError) throw this.stopError
    this.stopped = true
  }
}
function harness(
  root: string,
  options: { start?: ReturnType<typeof gate>; resume?: ReturnType<typeof gate> } = {},
) {
  const sessions: Session[] = []
  const runtime: ProviderRuntime = {
    listModels: async () => [],
    start: async (workspacePath) => {
      const session = new Session()
      const id = `task-${sessions.push(session)}`
      await options.start?.promise
      return { thread: { id, provider: 'codex', workspacePath, createdAt: Date.now() }, session }
    },
    resume: async (id, workspacePath) => {
      const session = new Session()
      sessions.push(session)
      await options.resume?.promise
      return { thread: { id, provider: 'codex', workspacePath, createdAt: Date.now() }, session }
    },
  }
  const store = new Store(':memory:')
  const orchestrator = new Orchestrator(store, {
    onEvent: () => {},
    onLog: () => {},
    onLogin: () => {},
    runtimeFor: () => runtime,
    worktreeRoot: path.join(root, 'worktrees'),
    mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
    modelConnections: new ModelConnectionStore(path.join(root, 'models.json')),
    customHarnesses: new CustomHarnessStore(path.join(root, 'harnesses.json')),
  })
  active.push({ orchestrator, store })
  return { orchestrator, store, sessions }
}
afterEach(async () => {
  for (const entry of active.splice(0)) {
    await entry.orchestrator.disposeAll()
    entry.store.close()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('audit integration regressions', () => {
  it('starts a shared task on the current branch and an isolated task on another branch while work runs', async () => {
    const { root, repo } = fixture()
    const { orchestrator, store } = harness(root)
    const running = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(running.id, 'working')
    await expect(
      orchestrator.startThread('codex', repo, { baseRef: 'main' }),
    ).resolves.toBeDefined()
    const isolated = await orchestrator.startThread('codex', repo, {
      isolate: true,
      baseRef: 'other',
    })
    expect(
      readFileSync(path.join(store.thread(isolated.id)!.worktreePath!, 'app.txt'), 'utf8'),
    ).toBe('other\n')
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    await expect(orchestrator.startThread('codex', repo, { baseRef: 'other' })).rejects.toThrow(
      /Chats are still working/,
    )
  })

  it('keeps a stopping checkout blocked, including failed stops, until retry succeeds', async () => {
    const { root, repo } = fixture()
    const { orchestrator, sessions } = harness(root)
    const task = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(task.id, 'working')
    const stop = gate()
    const session = sessions[0]!
    session.stopGate = stop
    session.stopError = new Error('process still alive')
    const closing = orchestrator.close(task.id)
    const refused = expect(closing).rejects.toThrow(/process still alive/)
    await expect(orchestrator.switchBranch(repo, 'other')).rejects.toThrow(
      /Chats are still working/,
    )
    stop.release()
    await refused
    await expect(orchestrator.switchBranch(repo, 'other')).rejects.toThrow(
      /Chats are still working/,
    )
    session.stopError = undefined
    await orchestrator.close(task.id)
    await expect(orchestrator.switchBranch(repo, 'other')).resolves.toMatchObject({
      branch: 'other',
    })
  })

  it.each([{ baseRef: 'other' }, { baseRef: 'other', isolate: true }])(
    'disposes a late start after shutdown with %j',
    async (options) => {
      const { root, repo } = fixture()
      const start = gate()
      const { orchestrator, sessions, store } = harness(root, { start })
      const starting = orchestrator.startThread('codex', repo, options)
      const rejected = expect(starting).rejects.toThrow(/cancelled by shutdown/)
      await vi.waitFor(() => expect(sessions).toHaveLength(1))
      await orchestrator.disposeAll()
      start.release()
      await rejected
      expect(sessions[0]!.stopped).toBe(true)
      expect(store.thread('task-1')).toBeUndefined()
      if (options.isolate)
        expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    },
  )

  it('cancels a submitted prompt across a cold resume and panic stop', async () => {
    const { root, repo } = fixture()
    const resume = gate()
    const { orchestrator, sessions, store } = harness(root, { resume })
    store.addProject(repo)
    store.addThread({
      id: 'saved',
      projectPath: repo,
      provider: 'codex',
      title: 'saved',
      createdAt: 1,
    })
    const submitting = orchestrator.submitTurn('saved', 'must not run after panic')
    const rejected = expect(submitting).rejects.toThrow(/panic stop/)
    await vi.waitFor(() => expect(sessions).toHaveLength(1))
    await orchestrator.panicStop()
    resume.release()
    await rejected
    expect(sessions[0]!.sent).toBe(0)
    expect(sessions[0]!.stopped).toBe(true)
    expect(store.queuedTurns('saved')).toEqual([])
  })

  it('retains every live worktree checkpoint and other databases while pruning cached refs', async () => {
    const { root, repo } = fixture()
    const isolated = path.join(root, 'isolated')
    const data = path.join(root, 'data')
    git(repo, 'worktree', 'add', '--detach', isolated)
    const store = new Store(path.join(data, 'tastecode.db'))
    let closed = false
    try {
      store.addProject(repo)
      for (const id of ['keep-main', 'keep-isolated', 'prune']) {
        store.addThread({
          id,
          projectPath: repo,
          provider: 'codex',
          title: id,
          createdAt: 1,
          ...(id === 'keep-isolated' ? { worktreePath: isolated, worktreeBranch: 'other' } : {}),
        })
      }
      writeFileSync(path.join(repo, 'app.txt'), 'main checkpoint\n')
      const main = await takeSnapshot(repo)
      writeFileSync(path.join(isolated, 'app.txt'), 'isolated checkpoint\n')
      const other = await takeSnapshot(isolated)
      const namespace = store.checkpointNamespace
      for (const [threadId, checkout, snapshot] of [
        ['keep-main', repo, main],
        ['keep-isolated', isolated, other],
      ] as const) {
        await retainCheckpoint(checkout, namespace, snapshot.commit)
        store.addCheckpoint({
          threadId,
          seq: 0,
          commit: snapshot.commit,
          clean: false,
          label: threadId,
        })
        store.recordCheckpointRepository(checkout)
      }
      await retainCheckpoint(repo, 'another-database', main.commit)
      store.closeThread('prune')
      store.close()
      closed = true
      await runHistoryCli(
        [
          'prune',
          '--before',
          '2099-01-01',
          '--archive',
          path.join(root, 'archive.ndjson'),
          '--apply',
        ],
        { HARNESS_DATA_DIR: data },
        () => {},
      )
      const retained = git(
        repo,
        'for-each-ref',
        '--format=%(objectname)',
        `refs/harness/checkpoints/${namespace}/`,
      ).split('\n')
      expect(retained).toContain(main.commit)
      expect(retained).toContain(other.commit)
      expect(
        git(
          repo,
          'for-each-ref',
          '--format=%(objectname)',
          'refs/harness/checkpoints/another-database/',
        ),
      ).toBe(main.commit)
      expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/harness/snapshots/')).toBe('')
      git(repo, 'gc', '--prune=now')
      expect(git(repo, 'show', `${main.commit}:app.txt`)).toBe('main checkpoint')
      expect(git(repo, 'show', `${other.commit}:app.txt`)).toBe('isolated checkpoint')
      expect(existsSync(path.join(root, 'archive.ndjson'))).toBe(true)
    } finally {
      if (!closed) store.close()
    }
  })
})
