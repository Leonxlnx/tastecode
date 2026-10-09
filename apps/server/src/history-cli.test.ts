import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { emptyThread, reduceEventLog } from '../../web/src/thread-store.js'
import { retainCheckpoint } from './checkpoint.js'
import { Store } from './store.js'
import { runHistoryCli } from './history-cli.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-history-clean-'))
  roots.push(root)
  const store = new Store(path.join(root, 'tastecode.db'))
  store.addProject(root)
  for (const id of ['old', 'active', 'isolated']) {
    store.addThread({
      id,
      projectPath: root,
      provider: 'codex',
      title: id,
      createdAt: 1,
      ...(id === 'isolated'
        ? { worktreePath: path.join(root, 'checkout'), worktreeBranch: 'saved' }
        : {}),
    })
    store.append(id, { type: 'thread.error', threadId: id, message: `history of ${id}` })
  }
  store.closeThread('old')
  store.closeThread('isolated')
  return { store, root }
}
/** One closed and one active task, each with a checkpoint protected by a Git ref. */
async function checkpointed() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-history-refs-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const store = new Store(path.join(root, 'tastecode.db'))
  store.addProject(repo)
  const commits: Record<string, string> = {}
  const checkpoint = async (threadId: string) => {
    git('commit', '--allow-empty', '-m', threadId)
    commits[threadId] = git('rev-parse', 'HEAD')
    store.addCheckpoint({ threadId, seq: 1, commit: commits[threadId], label: threadId })
    await retainCheckpoint(repo, store.checkpointNamespace, commits[threadId])
  }
  for (const id of ['old', 'active']) {
    store.addThread({ id, projectPath: repo, provider: 'codex', title: id, createdAt: 1 })
    await checkpoint(id)
  }
  store.closeThread('old')
  const refs = () =>
    git('for-each-ref', '--format=%(refname:short)', 'refs/harness/checkpoints/')
      .split('\n')
      .filter(Boolean)
      .map((ref) => ref.slice(ref.lastIndexOf('/') + 1))
      .sort()
  const prune = (output?: (line: string) => void) =>
    runHistoryCli(
      ['prune', '--before', '2099-01-01', '--archive', path.join(root, 'pruned.ndjson'), '--apply'],
      { HARNESS_DATA_DIR: root },
      output,
    )
  const thread = (id: string) => {
    const reopened = new Store(path.join(root, 'tastecode.db'))
    try {
      return reopened.thread(id)
    } finally {
      reopened.close()
    }
  }
  return { root, repo, store, commits, checkpoint, refs, prune, thread }
}
describe('history maintenance', () => {
  it('exports real rows, previews cleanup, then removes only closed tasks without a checkout', async () => {
    const { store, root } = setup()
    expect(store.historyStorage()).toMatchObject({ threads: 3, closedThreads: 2, events: 3 })
    const exportPath = path.join(root, 'export.ndjson')
    store.exportHistory(exportPath)
    expect(readFileSync(exportPath, 'utf8')).toContain('history of active')
    expect(store.historyCleanupCandidates(Date.now() + 1000)).toEqual(['old'])
    const archive = path.join(root, 'pruned.ndjson')
    expect(store.pruneHistory(Date.now() + 1000, archive)).toBe(1)
    expect(readFileSync(archive, 'utf8')).toContain('history of old')
    expect(readFileSync(archive, 'utf8')).not.toContain('history of active')
    expect(store.thread('old')).toBeUndefined()
    expect(store.thread('active')).toBeDefined()
    expect(store.thread('isolated')).toBeDefined()
    expect(store.history('old')).toEqual([])
    store.reclaimHistorySpace()
    expect(store.historyStorage().events).toBe(2)
    store.close()
    const output: string[] = []
    await runHistoryCli(['stats'], { HARNESS_DATA_DIR: root }, (line) => output.push(line))
    expect(JSON.parse(output[0]!)).toMatchObject({ threads: 2, events: 2 })
  })
  it('compacts streamed fragments that completed items already contain', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-history-fold-'))
    roots.push(root)
    const store = new Store(path.join(root, 'tastecode.db'))
    store.addProject(root)
    store.addThread({ id: 't', projectPath: root, provider: 'codex', title: 't' })
    const item = (id: string, text: string, status: 'started' | 'completed') => ({
      id,
      turnId: 'turn-1',
      type: 'message' as const,
      role: 'assistant' as const,
      status,
      text,
      createdAt: 1,
    })
    const delta = (itemId: string, textDelta: string): DomainEvent => ({
      type: 'item.delta',
      turnId: 'turn-1',
      itemId,
      textDelta,
    })
    const events: DomainEvent[] = [
      {
        type: 'turn.started',
        turn: { id: 'turn-1', threadId: 't', status: 'running', createdAt: 1 },
      },
      { type: 'item.started', item: item('done', '', 'started') },
      delta('done', 'Hello '),
      delta('done', 'world'),
      { type: 'item.completed', item: item('done', 'Hello world', 'completed') },
      { type: 'item.started', item: item('blank', '', 'started') },
      delta('blank', 'kept because completion has no text'),
      { type: 'item.completed', item: item('blank', '', 'completed') },
      delta('recovered', 'delta-first '),
      { type: 'item.started', item: item('recovered', '', 'started') },
      delta('recovered', 'stays'),
      { type: 'item.completed', item: item('recovered', 'delta-first stays', 'completed') },
      { type: 'item.started', item: item('running', '', 'started') },
      delta('running', 'still streaming'),
      { type: 'turn.completed', turnId: 'turn-1', status: 'completed', completedAt: 2 },
    ]
    for (const event of events) store.append('t', event)
    const before = reduceEventLog(emptyThread, store.history('t'))
    store.close()

    const output: string[] = []
    await runHistoryCli(['compact'], { HARNESS_DATA_DIR: root }, (line) => output.push(line))
    expect(JSON.parse(output[0]!)).toMatchObject({ foldedDeltaEvents: 2 })

    const reopened = new Store(path.join(root, 'tastecode.db'))
    const history = reopened.history('t')
    reopened.close()
    expect(history).toHaveLength(events.length - 2)
    expect(reduceEventLog(emptyThread, history)).toEqual(before)
  })
  it('cannot delete history when its archive would overwrite an existing file', () => {
    const { store, root } = setup()
    const archive = path.join(root, 'existing.ndjson')
    writeFileSync(archive, 'keep this')
    expect(() => store.pruneHistory(Date.now() + 1000, archive)).toThrow()
    expect(store.thread('old')).toBeDefined()
    expect(readFileSync(archive, 'utf8')).toBe('keep this')
    store.close()
  })
  it('defaults to a dry run and requires an archive for apply', async () => {
    const { store, root } = setup()
    store.close()
    const env = { HARNESS_DATA_DIR: root }
    const output: string[] = []
    await runHistoryCli(['prune', '--before', '2099-01-01'], env, (line) => output.push(line))
    expect(JSON.parse(output[0]!)).toMatchObject({ dryRun: true, threadIds: ['old'] })
    await expect(
      runHistoryCli(['prune', '--before', '2099-01-01', '--apply'], env),
    ).rejects.toThrow(/archive/)
    await expect(runHistoryCli(['prune', '--before', '2099-02-30'], env)).rejects.toThrow(/valid/)
    const reopened = new Store(path.join(root, 'tastecode.db'))
    expect(reopened.thread('old')).toBeDefined()
    reopened.close()
    expect(existsSync(path.join(root, 'tastecode.db'))).toBe(true)
  })
  it('prunes past a recorded checkpoint directory that is no longer a Git repository', async () => {
    const { root, store, commits, refs, prune, thread } = await checkpointed()
    const stale = path.join(root, 'stale')
    mkdirSync(stale)
    store.recordCheckpointRepository(stale)
    store.close()
    const output: string[] = []
    await prune((line) => output.push(line))
    expect(output.join('\n')).toContain('Removed 1 closed tasks')
    expect(thread('old')).toBeUndefined()
    expect(refs()).toEqual([commits.active])
  })
  it('keeps every checkpoint ref when a retained task checkout cannot be located', async () => {
    const { root, repo, store, commits, checkpoint, refs, prune, thread } = await checkpointed()
    const broken = path.join(root, 'broken-checkout')
    mkdirSync(broken)
    store.addThread({
      id: 'kept',
      projectPath: repo,
      provider: 'codex',
      title: 'kept',
      createdAt: 1,
      worktreePath: broken,
      worktreeBranch: 'saved',
    })
    await checkpoint('kept')
    store.close()
    await expect(prune()).rejects.toThrow(/checkpoint refs could not be removed/)
    expect(thread('old')).toBeUndefined()
    expect(refs()).toEqual([commits.old, commits.active, commits.kept].sort())
  })
})
