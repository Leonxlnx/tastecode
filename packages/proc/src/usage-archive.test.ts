import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverFileArchive, discoverJsonlArchive, usageArchiveFile } from './usage-archive.js'

const temporaryDirectories: string[] = []
const read = async () => []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('usage archive discovery', () => {
  it('lists every non-empty JSONL file below a directory', async () => {
    const root = temporaryDirectory()
    mkdirSync(path.join(root, 'project', 'subagents'), { recursive: true })
    writeFileSync(path.join(root, 'top.jsonl'), '{}\n')
    writeFileSync(path.join(root, 'project', 'session.jsonl'), '{}\n')
    writeFileSync(path.join(root, 'project', 'subagents', 'agent.jsonl'), '{}\n')
    writeFileSync(path.join(root, 'project', 'empty.jsonl'), '')
    writeFileSync(path.join(root, 'project', 'notes.json'), '{}')

    const archive = await discoverJsonlArchive(root, read)

    expect(archive.available).toBe(true)
    expect(archive.files.map((file) => path.relative(root, file.path)).sort()).toEqual(
      [
        'top.jsonl',
        path.join('project', 'session.jsonl'),
        path.join('project', 'subagents', 'agent.jsonl'),
      ].sort(),
    )
    expect(archive.files.every((file) => file.read === read && file.size === 3)).toBe(true)
  })

  it('rejects a missing directory and reports a file in its place as unavailable', async () => {
    const root = temporaryDirectory()
    const file = path.join(root, 'sessions')
    writeFileSync(file, '{}\n')

    await expect(discoverJsonlArchive(path.join(root, 'missing'), read)).rejects.toThrow()
    expect(await discoverJsonlArchive(file, read)).toEqual({ available: false, files: [] })
  })

  it('treats an empty single log as no archive', async () => {
    const root = temporaryDirectory()
    const log = path.join(root, 'unified.jsonl')
    writeFileSync(log, '')
    expect(await discoverFileArchive(log, read)).toEqual({ available: false, files: [] })

    writeFileSync(log, '{}\n')
    const archive = await discoverFileArchive(log, read)
    expect(archive.available).toBe(true)
    expect(archive.files).toHaveLength(1)
    await expect(discoverFileArchive(path.join(root, 'missing.jsonl'), read)).rejects.toThrow()
  })

  it('folds companion files into the fingerprint', async () => {
    const root = temporaryDirectory()
    const database = path.join(root, 'history.db')
    const wal = `${database}-wal`
    writeFileSync(database, '')
    writeFileSync(wal, 'appended')
    utimesSync(database, new Date('2026-08-08T09:00:00Z'), new Date('2026-08-08T09:00:00Z'))
    utimesSync(wal, new Date('2026-08-08T10:00:00Z'), new Date('2026-08-08T10:00:00Z'))

    expect(await usageArchiveFile(database, read, [wal])).toBeUndefined()
    const file = await usageArchiveFile(database, read, [wal, `${database}-missing`], true)
    expect(file).toMatchObject({
      path: database,
      size: 8,
      mtimeMs: new Date('2026-08-08T10:00:00Z').getTime(),
    })
  })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-usage-archive-'))
  temporaryDirectories.push(directory)
  return directory
}
