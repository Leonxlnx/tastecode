import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InventoryWatcher, type FolderWatch } from './inventory-watch.js'

type FakeFolder = {
  directory: string
  emit: (filename: string | null) => void
  closed: boolean
}

function fakeWatch(missing: Set<string> = new Set()) {
  const folders: FakeFolder[] = []
  const watch: FolderWatch = (directory, listener) => {
    if (missing.has(directory)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const folder: FakeFolder = {
      directory,
      emit: (filename) => {
        if (!folder.closed) listener('change', filename)
      },
      closed: false,
    }
    folders.push(folder)
    return {
      close: () => {
        folder.closed = true
      },
      on: () => ({}) as never,
    }
  }
  return { watch, folders, open: () => folders.filter((folder) => !folder.closed) }
}

const config = path.join(path.sep, 'home', 'dev', '.claude')
const project = path.join(path.sep, 'work', 'project')
const targets = () => [
  { directory: config, names: ['settings.json', 'skills'] },
  { directory: path.join(config, 'skills') },
  { directory: project, names: ['.mcp.json', '.claude'] },
]

describe('inventory watcher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports one change per burst, only for the entries that matter', async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const onChange = vi.fn()
    const watcher = new InventoryWatcher({ targets, onChange, ttlMs: 60_000, watch: fake.watch })
    watcher.lease(project)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.open().map((folder) => folder.directory)).toEqual([
      config,
      path.join(config, 'skills'),
      project,
    ])

    // Claude writes history and session files next to its settings all the time.
    fake.open()[0]!.emit('history.jsonl')
    fake.open()[2]!.emit('README.md')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onChange).not.toHaveBeenCalled()

    // Windows reports one save as two events.
    fake.open()[2]!.emit('.mcp.json')
    fake.open()[2]!.emit('.mcp.json')
    fake.open()[1]!.emit('new-skill')
    await vi.advanceTimersByTimeAsync(499)
    expect(onChange).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onChange.mock.calls).toEqual([[project]])
    watcher.clear()
  })

  it('watches a folder that appears after the lease began', async () => {
    vi.useFakeTimers()
    const skills = path.join(config, 'skills')
    const missing = new Set([skills])
    const fake = fakeWatch(missing)
    const onChange = vi.fn()
    const watcher = new InventoryWatcher({ targets, onChange, ttlMs: 60_000, watch: fake.watch })
    watcher.lease(project)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.open().map((folder) => folder.directory)).toEqual([config, project])

    missing.delete(skills)
    fake.open()[0]!.emit('skills')
    await vi.advanceTimersByTimeAsync(500)
    expect(onChange).toHaveBeenCalledOnce()
    expect(fake.open().map((folder) => folder.directory)).toEqual([config, skills, project])
    watcher.clear()
  })

  it('closes every folder when the lease lapses and keeps it while renewed', async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const onChange = vi.fn()
    const watcher = new InventoryWatcher({ targets, onChange, ttlMs: 60_000, watch: fake.watch })
    watcher.lease(project)
    await vi.advanceTimersByTimeAsync(30_000)
    watcher.lease(project)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(fake.open()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.open()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    // A change that raced the expiry reports nothing.
    fake.folders[0]!.emit('settings.json')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stops for a forgotten project and on clear', async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const watcher = new InventoryWatcher({
      targets,
      onChange: vi.fn(),
      ttlMs: 60_000,
      watch: fake.watch,
    })
    watcher.lease(project)
    watcher.lease(path.join(path.sep, 'work', 'other'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.open()).toHaveLength(6)
    watcher.forget(project)
    expect(fake.open()).toHaveLength(3)
    watcher.clear()
    expect(fake.open()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('notices a real change to a project MCP file', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-inventory-watch-'))
    const projectPath = path.join(root, 'project')
    mkdirSync(projectPath)
    const onChange = vi.fn()
    const watcher = new InventoryWatcher({
      targets: (folder) => [{ directory: folder, names: ['.mcp.json'] }],
      onChange,
      ttlMs: 60_000,
      debounceMs: 50,
    })
    try {
      watcher.lease(projectPath)
      await new Promise((resolve) => setTimeout(resolve, 100))
      writeFileSync(path.join(projectPath, 'notes.txt'), 'unrelated')
      writeFileSync(path.join(projectPath, '.mcp.json'), '{"mcpServers":{}}')
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(projectPath), {
        timeout: 5_000,
      })
    } finally {
      watcher.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
