import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { UsageCheckpoint, UsageLogRead } from './usage-log.js'

/**
 * One local history file an adapter can parse. Size and mtime are the
 * fingerprint the server compares to skip files that did not change.
 */
export type UsageArchiveFile<Entry> = {
  path: string
  mtimeMs: number
  size: number
  read: (filePath: string) => Promise<Entry[]>
  /** For logs that are only ever appended to: reads on from an earlier read's checkpoint. */
  readFrom?: UsageLogReader<Entry>
}

export type UsageLogReader<Entry> = (
  filePath: string,
  checkpoint?: UsageCheckpoint,
) => Promise<UsageLogRead<Entry>>

export type UsageArchive<Entry> = {
  available: boolean
  files: UsageArchiveFile<Entry>[]
}

/**
 * Where a provider keeps its local usage history and how to list it. The
 * adapter owns the CLI home, its environment variable and the file layout;
 * the server only fingerprints and parses the files it is handed.
 */
export type UsageHistorySource<Provider extends string, Entry> = {
  provider: Provider
  label: string
  /** The archive location inside a CLI home, or inside the CLI's own default home. */
  root(home?: string): string
  /** Lists the archive at `root`. A missing archive rejects or reports unavailable. */
  discover(root: string): Promise<UsageArchive<Entry>>
}

/** Every non-empty `.jsonl` file below a directory, for per-session logs. */
export async function discoverJsonlArchive<Entry>(
  root: string,
  read: UsageArchiveFile<Entry>['read'],
  readFrom?: UsageLogReader<Entry>,
): Promise<UsageArchive<Entry>> {
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) return { available: false, files: [] }
  return { available: true, files: await listJsonlFiles(root, read, readFrom) }
}

/** One log file; an empty file counts as no archive. */
export async function discoverFileArchive<Entry>(
  filePath: string,
  read: UsageArchiveFile<Entry>['read'],
  readFrom?: UsageLogReader<Entry>,
): Promise<UsageArchive<Entry>> {
  const file = await usageArchiveFile(filePath, read)
  if (!file) return { available: false, files: [] }
  return { available: true, files: [readFrom ? { ...file, readFrom } : file] }
}

/**
 * Fingerprints one file. Companion files (a SQLite WAL, for example) fold
 * into the fingerprint so appends there still mark the archive as changed.
 */
export async function usageArchiveFile<Entry>(
  filePath: string,
  read: UsageArchiveFile<Entry>['read'],
  companions: readonly string[] = [],
  allowEmpty = false,
): Promise<UsageArchiveFile<Entry> | undefined> {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || (!allowEmpty && fileStat.size === 0)) return undefined
  let mtimeMs = fileStat.mtimeMs
  let size = fileStat.size
  for (const companion of companions) {
    try {
      const companionStat = await stat(companion)
      mtimeMs = Math.max(mtimeMs, companionStat.mtimeMs)
      size += companionStat.size
    } catch {
      // A database without a WAL is the common clean-shutdown state.
    }
  }
  return { path: filePath, mtimeMs, size, read }
}

async function listJsonlFiles<Entry>(
  root: string,
  read: UsageArchiveFile<Entry>['read'],
  readFrom: UsageLogReader<Entry> | undefined,
): Promise<UsageArchiveFile<Entry>[]> {
  const result: UsageArchiveFile<Entry>[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          pending.push(fullPath)
          return
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return
        try {
          const file = await usageArchiveFile(fullPath, read)
          if (file) result.push(readFrom ? { ...file, readFrom } : file)
        } catch {
          // A session can disappear between readdir and stat during cleanup.
        }
      }),
    )
  }
  return result
}
