import path from 'node:path'
import type { ProviderHistorySession } from '@harness/contracts'
import { object } from './history-values.js'

/** `internal` is known only when the index records each thread's source. */
export type IndexedSession = { session: ProviderHistorySession; name?: string; internal?: boolean }

export const PREVIEW_LENGTH = 200

export async function indexedSessions(home: string, files: string[]): Promise<IndexedSession[]> {
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

/** The index stores a plain label (`cli`) or the rollout's JSON source object. */
function subagentSource(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('{')) return false
  try {
    return 'subagent' in object(JSON.parse(value))
  } catch {
    return false
  }
}

export function previewTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.slice(0, PREVIEW_LENGTH).replace(/\s+/g, ' ').trim() || 'Codex chat'
    : 'Codex chat'
}
