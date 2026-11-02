import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

const ROLLOUT_FOLDERS = ['sessions', 'archived_sessions']
/** Forks of forks, as far as a copy follows them. */
const MAX_LINEAGE = 32

/**
 * Copies a saved thread's rollout from one Codex home into another, at the
 * same place under it, so the Codex running in `to` can resume or fork the
 * thread. Codex 0.163 saves a fork as a reference to the thread it was forked
 * from, so those threads' rollouts come along. A rollout already in `to` is
 * replaced: `from` is where the thread ran last.
 *
 * Resolves the thread and the threads it descends from, nearest first, or
 * undefined when `from` lacks one of their rollouts.
 */
export async function copyCodexThread(
  threadId: string,
  from: string,
  to: string,
): Promise<string[] | undefined> {
  const source = path.resolve(from)
  const target = path.resolve(to)
  const lineage: string[] = []
  let next: string | undefined = threadId
  while (next !== undefined && !lineage.includes(next) && lineage.length < MAX_LINEAGE) {
    const rollout = await findRollout(source, next)
    // A fork whose parent is gone has lost its earlier turns, here as in `from`.
    if (!rollout) return undefined
    lineage.push(next)
    if (source !== target) {
      const copy = path.join(target, path.relative(source, rollout))
      await mkdir(path.dirname(copy), { recursive: true })
      // Copied beside its final name, so Codex never reads half a rollout.
      const partial = `${copy}.${randomUUID()}.partial`
      try {
        await copyFile(rollout, partial)
        await rename(partial, copy)
      } catch (error) {
        await rm(partial, { force: true })
        throw error
      }
    }
    next = await forkedFrom(rollout)
  }
  return lineage
}

/** A thread's rollout in a Codex home, found by the id its file name ends with. */
async function findRollout(home: string, threadId: string): Promise<string | undefined> {
  const suffix = `-${threadId}.jsonl`
  const walk = async (directory: string): Promise<string | undefined> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return undefined
    }
    const file = entries.find(
      (entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix),
    )
    if (file) return path.join(directory, file.name)
    // Dated folders, newest first: a chat that is carried on ran recently.
    const folders = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const folder of folders) {
      const found = await walk(path.join(directory, folder))
      if (found) return found
    }
    return undefined
  }
  for (const folder of ROLLOUT_FOLDERS) {
    const found = await walk(path.join(home, folder))
    if (found) return found
  }
  return undefined
}

/** The thread a rollout was forked from, as its opening `session_meta` record names it. */
async function forkedFrom(rollout: string): Promise<string | undefined> {
  const input = createReadStream(rollout, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const record: unknown = JSON.parse(line)
      if (record === null || typeof record !== 'object' || !('payload' in record)) return undefined
      const payload = record.payload
      if (payload === null || typeof payload !== 'object' || !('forked_from_id' in payload))
        return undefined
      const parent = payload.forked_from_id
      return typeof parent === 'string' && parent ? parent : undefined
    }
    return undefined
  } catch {
    return undefined
  } finally {
    lines.close()
    input.destroy()
  }
}
