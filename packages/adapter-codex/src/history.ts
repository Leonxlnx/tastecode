import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { ProviderHistorySession, ProviderHistorySource } from '@harness/contracts'
import { parseCodexHistory } from './history-transcript.js'
import { object, timestamp } from './history-values.js'

type JsonObject = Record<string, unknown>
type SavedFile = { file: string; archived: boolean; size: number; mtimeMs: number }
type IndexedSession = { session: ProviderHistorySession; name?: string }
const PREVIEW_LENGTH = 200

export type CodexHistoryOptions = { codexHome?: string }

/** Reads Codex's local store without starting app-server or changing its files. */
export function createCodexHistorySource(options: CodexHistoryOptions = {}): ProviderHistorySource {
  const home = path.resolve(
    options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  )
  const known = new Map<string, ProviderHistorySession>()
  const headers = new Map<string, { revision: string; session: ProviderHistorySession | null }>()
  let listing: Promise<ProviderHistorySession[]> | undefined

  async function list(): Promise<ProviderHistorySession[]> {
    const rows = await indexedSessions(home)
    const byFile = new Map(
      rows.flatMap((entry) =>
        entry.session.locator ? [[path.resolve(entry.session.locator), entry] as const] : [],
      ),
    )
    const names = await sessionNames(home)
    const files = await savedFiles(home)
    const sessions = new Map<string, ProviderHistorySession>()
    // Bound open files; a profile can contain thousands of transcripts.
    for (let offset = 0; offset < files.length; offset += 32) {
      await Promise.all(
        files.slice(offset, offset + 32).map(async (saved) => {
          const revision = `${saved.size}:${saved.mtimeMs}`
          const indexed = byFile.get(saved.file)
          let session = indexed?.session
          if (!session) {
            const cached = headers.get(saved.file)
            const header = cached?.revision === revision ? cached.session : await readHeader(saved)
            headers.set(saved.file, { revision, session: header })
            session = header ?? undefined
          }
          if (!session) return
          const named = names.get(session.id)
          // `name` is the native user-facing title; `title`/`preview` can contain the full prompt.
          // A newer sidecar record can precede the matching SQLite rename transaction.
          const title =
            named && (!indexed?.name || named.updatedAt > session.updatedAt)
              ? named.title
              : (indexed?.name ?? session.title)
          const result = {
            ...session,
            title,
            updatedAt: Math.max(session.updatedAt, named?.updatedAt ?? 0, saved.mtimeMs),
            revision: createHash('sha256')
              .update(
                JSON.stringify([
                  revision,
                  session.updatedAt,
                  named?.updatedAt ?? 0,
                  title,
                  session.workspacePath,
                  saved.archived,
                ]),
              )
              .digest('hex'),
            archived: saved.archived,
            locator: saved.file,
          }
          const previous = sessions.get(result.id)
          if (!previous || previous.updatedAt < result.updatedAt) sessions.set(result.id, result)
        }),
      )
    }
    known.clear()
    for (const [id, session] of sessions) known.set(id, session)
    const existingFiles = new Set(files.map((file) => file.file))
    for (const file of headers.keys()) if (!existingFiles.has(file)) headers.delete(file)
    return [...sessions.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    )
  }

  return {
    list() {
      listing ??= list().finally(() => {
        listing = undefined
      })
      return listing
    },
    async read(session) {
      if (!known.has(session.id)) await this.list()
      // Locators from callers never grant access to arbitrary local files.
      const saved = known.get(session.id)
      if (!saved?.locator || !(await allowedFile(home, saved.locator))) return []
      const records: JsonObject[] = []
      for await (const record of jsonLines(saved.locator)) records.push(record)
      return parseCodexHistory(records, saved)
    },
    dispose() {
      known.clear()
      headers.clear()
    },
  }
}

async function allowedFile(home: string, file: string): Promise<boolean> {
  try {
    const canonicalHome = await realpath(home)
    const relative = path.relative(canonicalHome, await realpath(file)).split(path.sep)
    return (
      ['sessions', 'archived_sessions'].includes(relative[0] ?? '') &&
      !relative.includes('..') &&
      path.extname(file) === '.jsonl' &&
      (await stat(file)).isFile()
    )
  } catch {
    return false
  }
}

async function savedFiles(home: string): Promise<SavedFile[]> {
  const result: SavedFile[] = []
  async function walk(directory: string, archived: boolean): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file, archived)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const info = await stat(file)
          result.push({ file, archived, size: info.size, mtimeMs: info.mtimeMs })
        } catch {
          /* A provider can archive or remove a file during discovery. */
        }
      }
    }
  }
  await Promise.all(
    ['sessions', 'archived_sessions'].map((name) =>
      walk(path.join(home, name), name === 'archived_sessions'),
    ),
  )
  return result
}

async function indexedSessions(home: string): Promise<IndexedSession[]> {
  let files: string[]
  try {
    files = (await readdir(home)).filter((file) => /^state_\d+\.sqlite$/.test(file))
  } catch {
    return []
  }
  files.sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))
  for (const file of files) {
    let db: import('node:sqlite').DatabaseSync | undefined
    try {
      const { DatabaseSync } = await import('node:sqlite')
      db = new DatabaseSync(path.join(home, file), { readOnly: true })
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(threads)')
          .all()
          .map((row) => row.name),
      )
      const created = columns.has('created_at_ms')
        ? 'COALESCE(created_at_ms, created_at * 1000)'
        : 'created_at * 1000'
      const updated = columns.has('updated_at_ms')
        ? 'COALESCE(updated_at_ms, updated_at * 1000)'
        : 'updated_at * 1000'
      const name = columns.has('name') ? 'name' : 'NULL'
      const preview = columns.has('preview') ? "COALESCE(NULLIF(preview, ''), title)" : 'title'
      return db
        .prepare(
          `SELECT id, rollout_path, cwd, ${name} AS name, substr(${preview}, 1, ${PREVIEW_LENGTH}) AS preview, ${created} AS created, ${updated} AS updated FROM threads`,
        )
        .all()
        .flatMap((row) => {
          if (
            typeof row.id !== 'string' ||
            typeof row.rollout_path !== 'string' ||
            typeof row.cwd !== 'string'
          )
            return []
          return [
            {
              ...(typeof row.name === 'string' && row.name.trim() ? { name: row.name } : {}),
              session: {
                id: row.id,
                workspacePath: row.cwd,
                title: previewTitle(row.preview),
                createdAt: Number(row.created),
                updatedAt: Number(row.updated),
                revision: String(row.updated),
                locator: row.rollout_path,
              },
            },
          ]
        })
    } catch {
      /* Older, unavailable, or locked indexes fall back to rollout metadata. */
    } finally {
      db?.close()
    }
  }
  return []
}

async function sessionNames(
  home: string,
): Promise<Map<string, { title: string; updatedAt: number }>> {
  const result = new Map<string, { title: string; updatedAt: number }>()
  for await (const record of jsonLines(path.join(home, 'session_index.jsonl'))) {
    if (
      typeof record.id === 'string' &&
      typeof record.thread_name === 'string' &&
      record.thread_name.trim()
    ) {
      const value = {
        title: record.thread_name,
        updatedAt: timestamp(record.updated_at, 0),
      }
      if (value.updatedAt >= (result.get(record.id)?.updatedAt ?? 0)) result.set(record.id, value)
    }
  }
  return result
}

async function readHeader(saved: SavedFile): Promise<ProviderHistorySession | null> {
  // Native rollouts start with metadata. Stop before loading the actual transcript.
  let scanned = 0
  for await (const record of jsonLines(saved.file)) {
    if (++scanned > 16) break
    const payload = object(record.payload)
    if (
      record.type !== 'session_meta' ||
      typeof payload.id !== 'string' ||
      typeof payload.cwd !== 'string'
    )
      continue
    return {
      id: payload.id,
      workspacePath: payload.cwd,
      title: previewTitle(payload.title),
      createdAt: timestamp(payload.timestamp ?? record.timestamp, saved.mtimeMs),
      updatedAt: saved.mtimeMs,
      revision: `${saved.size}:${saved.mtimeMs}`,
      locator: saved.file,
      archived: saved.archived,
    }
  }
  return null
}

function previewTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.slice(0, PREVIEW_LENGTH).replace(/\s+/g, ' ').trim() || 'Codex chat'
    : 'Codex chat'
}

async function* jsonLines(file: string): AsyncGenerator<JsonObject> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      try {
        const value: unknown = JSON.parse(line)
        if (value !== null && typeof value === 'object' && !Array.isArray(value))
          yield value as JsonObject
      } catch {
        /* Partial trailing writes and malformed rows cannot hide the rest. */
      }
    }
  } catch {
    /* Missing and concurrently removed history files are normal. */
  } finally {
    lines.close()
    input.destroy()
  }
}
