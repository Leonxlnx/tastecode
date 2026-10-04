import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  stat as callbackStat,
  type Dirent,
  type Stats,
} from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { isSecretWorkspaceName } from './api-workspace-paths.js'
import {
  compareWorkspaceEntries,
  listWorkspaceDirectory,
  type WorkspaceFileEntry,
} from './workspace-files.js'

const ENTRY_COUNT = 10_000
const SAMPLES = 5
const CONCURRENCY_LEVELS = [32, 64] as const
const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-workspace-listing-'))

function collect(): NodeJS.MemoryUsage {
  for (let index = 0; index < 3; index += 1) global.gc?.()
  return process.memoryUsage()
}

function entryFrom(
  name: string,
  kind: WorkspaceFileEntry['kind'],
  metadata: Stats,
): WorkspaceFileEntry {
  return {
    name,
    path: name,
    kind,
    size: metadata.size,
    modifiedAt: metadata.mtimeMs,
    restricted: false,
  }
}

async function listUnbounded(children: Dirent[]): Promise<WorkspaceFileEntry[]> {
  return (
    await Promise.all(
      children.map(async (entry) => {
        const metadata = await stat(path.join(directory, entry.name))
        return entryFrom(entry.name, entry.isDirectory() ? 'directory' : 'file', metadata)
      }),
    )
  ).sort(compareWorkspaceEntries)
}

async function listLegacyWorkspaceDirectory(): Promise<WorkspaceFileEntry[]> {
  const workspace = await realpath(directory)
  if (!(await stat(workspace)).isDirectory()) throw new Error('path must be a directory')
  const children = await readdir(workspace, { withFileTypes: true })
  return (
    await Promise.all(
      children.map(async (entry): Promise<WorkspaceFileEntry | undefined> => {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return undefined
        const absolute = path.join(workspace, entry.name)
        try {
          const metadata = await stat(absolute)
          const relative = path.relative(workspace, absolute).split(path.sep).join('/')
          return {
            name: entry.name,
            path: relative,
            kind: entry.isDirectory() ? 'directory' : 'file',
            size: metadata.size,
            modifiedAt: metadata.mtimeMs,
            restricted: relative.split('/').some(isSecretWorkspaceName),
          }
        } catch {
          return undefined
        }
      }),
    )
  )
    .filter((entry): entry is WorkspaceFileEntry => entry !== undefined)
    .sort(compareWorkspaceEntries)
}

async function listBounded(children: Dirent[], concurrency: number): Promise<WorkspaceFileEntry[]> {
  const entries: WorkspaceFileEntry[] = []
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < children.length) {
      const index = nextIndex++
      const entry = children[index]!
      const metadata = await stat(path.join(directory, entry.name))
      entries[index] = entryFrom(entry.name, entry.isDirectory() ? 'directory' : 'file', metadata)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, children.length) }, () => worker()))
  return entries.sort(compareWorkspaceEntries)
}

function listWithCallbacks(children: Dirent[]): Promise<WorkspaceFileEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: WorkspaceFileEntry[] = []
    let remaining = children.length
    let failed = false
    if (remaining === 0) {
      resolve(entries)
      return
    }
    for (let index = 0; index < children.length; index += 1) {
      const entry = children[index]!
      callbackStat(path.join(directory, entry.name), (error, metadata) => {
        if (failed) return
        if (error || !metadata) {
          failed = true
          reject(error ?? new Error('missing file metadata'))
          return
        }
        entries[index] = entryFrom(entry.name, entry.isDirectory() ? 'directory' : 'file', metadata)
        remaining -= 1
        if (remaining === 0) resolve(entries.sort(compareWorkspaceEntries))
      })
    }
  })
}

async function measure(
  name: string,
  operation: () => Promise<WorkspaceFileEntry[]>,
): Promise<{ name: string; milliseconds: number; scheduledHeapBytes: number }> {
  const before = collect()
  const startedAt = performance.now()
  const pending = operation()
  const scheduled = process.memoryUsage()
  const entries = await pending
  const milliseconds = performance.now() - startedAt
  if (entries.length !== ENTRY_COUNT) throw new Error(`expected ${ENTRY_COUNT} entries`)
  return {
    name,
    milliseconds,
    scheduledHeapBytes: scheduled.heapUsed - before.heapUsed,
  }
}

function summarize(
  measurements: Array<{ name: string; milliseconds: number; scheduledHeapBytes: number }>,
) {
  const byName = new Map<string, typeof measurements>()
  for (const measurement of measurements) {
    const values = byName.get(measurement.name) ?? []
    values.push(measurement)
    byName.set(measurement.name, values)
  }
  return [...byName].map(([name, values]) => ({
    name,
    meanMilliseconds:
      values.reduce((total, value) => total + value.milliseconds, 0) / values.length,
    meanScheduledHeapBytes:
      values.reduce((total, value) => total + value.scheduledHeapBytes, 0) / values.length,
  }))
}

try {
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    closeSync(openSync(path.join(directory, `entry-${String(index).padStart(5, '0')}.ts`), 'w'))
  }
  const children = await readdir(directory, { withFileTypes: true })
  await listUnbounded(children)

  const measurements: Array<{
    name: string
    milliseconds: number
    scheduledHeapBytes: number
  }> = []
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    measurements.push(await measure('legacy-full', listLegacyWorkspaceDirectory))
    measurements.push(
      await measure('callback-full', async () => (await listWorkspaceDirectory(directory)).entries),
    )
    measurements.push(await measure('unbounded', () => listUnbounded(children)))
    measurements.push(await measure('callback-unbounded', () => listWithCallbacks(children)))
    for (const concurrency of CONCURRENCY_LEVELS) {
      measurements.push(
        await measure(`bounded-${concurrency}`, () => listBounded(children, concurrency)),
      )
    }
  }
  console.log(JSON.stringify(summarize(measurements)))
} finally {
  rmSync(directory, { recursive: true, force: true })
}
