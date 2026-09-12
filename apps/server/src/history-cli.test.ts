import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
})
