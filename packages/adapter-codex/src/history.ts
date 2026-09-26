import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { ProviderHistorySession, ProviderHistorySource } from '@harness/contracts'
import { parseCodexHistory } from './history-transcript.js'
import { object, timestamp } from './history-values.js'
import { transcriptRecords } from './rollout-records.js'

type JsonObject = Record<string, unknown>
type SavedFile = { file: string; archived: boolean; size: number; mtimeMs: number }
/** `internal` is known only when the index records each thread's source. */
type IndexedSession = { session: ProviderHistorySession; name?: string; internal?: boolean }
type SessionName = { title: string; updatedAt: number }
type SessionNames = Map<string, SessionName>
const PREVIEW_LENGTH = 200
const SESSION_NAMES_FILE = 'session_index.jsonl'

export type CodexHistoryOptions = { codexHome?: string }

/** Reads Codex's local store without starting app-server or changing its files. */
export function createCodexHistorySource(options: CodexHistoryOptions = {}): ProviderHistorySource {
  const home = path.resolve(
    options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  )
  const known = new Map<string, ProviderHistorySession>()
  const headers = new Map<string, { revision: string; session: ProviderHistorySession | null }>()
  // The server lists again on every background refresh. Unchanged stores and rollouts
  // reuse their previous results instead of re-reading the index and rehashing sessions.
  let index: { signature: string; byFile: Map<string, IndexedSession> } | undefined
  let sidecar: { signature: string; names: SessionNames } | undefined
  const results = new Map<string, { inputs: readonly unknown[]; session: ProviderHistorySession }>()
  let listing: Promise<ProviderHistorySession[]> | undefined

  async function list(): Promise<ProviderHistorySession[]> {
    const databases = await stateFiles(home)
    // A commit rewrites the database or its write-ahead log.
    const indexSignature = await filesSignature(
      home,
      databases.flatMap((file) => [file, `${file}-wal`]),
    )
    if (index?.signature !== indexSignature) {
      const rows = await indexedSessions(home, databases)
      index = {
        signature: indexSignature,
        byFile: new Map(
          rows.flatMap((entry) =>
            entry.session.locator ? [[path.resolve(entry.session.locator), entry] as const] : [],
          ),
        ),
      }
    }
    const byFile = index.byFile
    const namesSignature = await filesSignature(home, [SESSION_NAMES_FILE])
    if (sidecar?.signature !== namesSignature)
      sidecar = { signature: namesSignature, names: await sessionNames(home) }
    const names = sidecar.names
    const files = await savedFiles(home)
    const sessions = new Map<string, ProviderHistorySession>()
    // Bound open files; a profile can contain thousands of transcripts.
    for (let offset = 0; offset < files.length; offset += 32) {
      await Promise.all(
        files.slice(offset, offset + 32).map(async (saved) => {
          const revision = `${saved.size}:${saved.mtimeMs}`
          const indexed = byFile.get(saved.file)
          // Opening every rollout at startup read the first chunk of thousands of
          // transcripts. The index already carries everything the header would add.
          let header: ProviderHistorySession | null | undefined
          if (indexed?.internal === undefined) {
            const cached = headers.get(saved.file)
            header = cached?.revision === revision ? cached.session : await readHeader(saved)
            headers.set(saved.file, { revision, session: header })
          }
          const session = indexed?.session ?? header
          if (!session) return
          const named = names.get(session.id)
          const inputs = [revision, saved.archived, indexed, header, named] as const
          const reused = results.get(saved.file)
          const result = reused?.inputs.every((input, at) => input === inputs[at])
            ? reused.session
            : describeSession(session, saved, revision, indexed, header, named)
          if (result !== reused?.session) results.set(saved.file, { inputs, session: result })
          const previous = sessions.get(result.id)
          if (!previous || previous.updatedAt < result.updatedAt) sessions.set(result.id, result)
        }),
      )
    }
    known.clear()
    for (const [id, session] of sessions) known.set(id, session)
    const existingFiles = new Set(files.map((file) => file.file))
    for (const file of headers.keys()) if (!existingFiles.has(file)) headers.delete(file)
    for (const file of results.keys()) if (!existingFiles.has(file)) results.delete(file)
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
    async read(session, options) {
      if (!known.has(session.id)) await this.list()
      // Locators from callers never grant access to arbitrary local files.
      const saved = known.get(session.id)
      if (saved?.internal || !saved?.locator || !(await allowedFile(home, saved.locator))) return []
      return parseCodexHistory(await transcriptRecords(saved.locator, options?.localTurnIds), saved)
    },
    dispose() {
      known.clear()
      headers.clear()
      results.clear()
      index = undefined
      sidecar = undefined
    },
  }
}

function describeSession(
  session: ProviderHistorySession,
  saved: SavedFile,
  revision: string,
  indexed: IndexedSession | undefined,
  header: ProviderHistorySession | null | undefined,
  named: SessionName | undefined,
): ProviderHistorySession {
  // `name` is the native user-facing title; `title`/`preview` can contain the full prompt.
  // A newer sidecar record can precede the matching SQLite rename transaction.
  const title =
    named && (!indexed?.name || named.updatedAt > session.updatedAt)
      ? named.title
      : (indexed?.name ?? session.title)
  return {
    ...session,
    ...((indexed?.internal ?? header?.internal) ? { internal: true } : {}),
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
}

async function filesSignature(home: string, files: string[]): Promise<string> {
  const parts = await Promise.all(
    files.map((file) =>
      stat(path.join(home, file)).then(
        (info) => `${file}:${info.size}:${info.mtimeMs}`,
        () => `${file}:-`,
      ),
    ),
  )
  return parts.join('|')
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

/** Codex's state databases, newest schema first. */
async function stateFiles(home: string): Promise<string[]> {
  try {
    const files = (await readdir(home)).filter((file) => /^state_\d+\.sqlite$/.test(file))
    return files.sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))
  } catch {
    return []
  }
}

async function indexedSessions(home: string, files: string[]): Promise<IndexedSession[]> {
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
      const hasSource = columns.has('source')
      return db
        .prepare(
          `SELECT id, rollout_path, cwd, ${name} AS name, substr(${preview}, 1, ${PREVIEW_LENGTH}) AS preview, ${created} AS created, ${updated} AS updated, ${hasSource ? 'source' : 'NULL'} AS source FROM threads`,
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
              ...(hasSource ? { internal: subagentSource(row.source) } : {}),
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

async function sessionNames(home: string): Promise<SessionNames> {
  const result: SessionNames = new Map()
  for await (const record of jsonLines(path.join(home, SESSION_NAMES_FILE))) {
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
      ...('subagent' in object(payload.source) ? { internal: true } : {}),
    }
  }
  return null
}

/** The index stores a plain label (`cli`) or the rollout's JSON source object. */
function subagentSource(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('{')) return false
  try {
    return 'subagent' in object(JSON.parse(value))
  } catch {
    return false
  }
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
