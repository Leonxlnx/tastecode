import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProviderHistorySession, ProviderHistorySource } from '@harness/contracts'
import { grokHistoryEvents, record, text } from './history-transcript.js'

export type GrokHistoryOptions = { root?: string }

/** Read Grok's local session store without launching the CLI or modifying its files. */
export function createGrokHistorySource(options: GrokHistoryOptions = {}): ProviderHistorySource {
  const root = path.resolve(options.root ?? process.env.GROK_HOME ?? path.join(homedir(), '.grok'))
  const sessionsRoot = path.join(root, 'sessions')
  return {
    async list() {
      const sessions: ProviderHistorySession[] = []
      for (const workspace of await directories(sessionsRoot)) {
        const folder = path.join(sessionsRoot, workspace)
        const names = await directories(folder)
        // Bound disk work when a provider has thousands of saved sessions.
        for (let offset = 0; offset < names.length; offset += 16) {
          const batch = await Promise.all(
            names.slice(offset, offset + 16).map(async (id) => {
              const directory = path.join(folder, id)
              const [summaryText, summaryStat, updatesStat, chatStat] = await Promise.all([
                readSessionFile(directory, 'summary.json'),
                stat(path.join(directory, 'summary.json')).catch(() => undefined),
                stat(path.join(directory, 'updates.jsonl')).catch(() => undefined),
                stat(path.join(directory, 'chat_history.jsonl')).catch(() => undefined),
              ])
              if (!updatesStat && !chatStat) return undefined
              const summary = parseRecord(summaryText)
              const info = record(summary.info)
              let decoded = ''
              try {
                decoded = decodeURIComponent(workspace)
              } catch {
                /* Invalid folders stay isolated. */
              }
              const workspacePath = text(info.cwd) ?? decoded
              if (!path.isAbsolute(workspacePath)) return undefined
              const updatedAt = Math.max(
                updatesStat?.mtimeMs ?? 0,
                chatStat?.mtimeMs ?? 0,
                date(summary.updated_at, 0),
                date(summary.last_active_at, 0),
              )
              return {
                id: text(info.id) ?? id,
                workspacePath,
                title:
                  text(summary.generated_title) ??
                  text(summary.title) ??
                  text(summary.session_summary) ??
                  'Grok chat',
                createdAt: date(
                  summary.created_at,
                  chatStat?.birthtimeMs ?? updatesStat?.birthtimeMs ?? updatedAt,
                ),
                updatedAt,
                revision: [summaryStat, updatesStat, chatStat]
                  .map((s) => (s ? `${s.size}:${s.mtimeMs}` : '-'))
                  .join('|'),
                locator: directory,
                ...(summary.archived === true ? { archived: true } : {}),
              } satisfies ProviderHistorySession
            }),
          )
          for (const session of batch) if (session) sessions.push(session)
        }
      }
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    },
    async read(session) {
      if (!session.locator) return []
      const [base, directory] = await Promise.all([
        realpath(sessionsRoot).catch(() => ''),
        realpath(session.locator).catch(() => ''),
      ])
      const relative = path.relative(base, directory)
      if (
        !base ||
        !directory ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).length !== 2
      )
        return []
      const [updates, chat] = await Promise.all([
        readSessionFile(directory, 'updates.jsonl'),
        readSessionFile(directory, 'chat_history.jsonl'),
      ])
      return grokHistoryEvents(session, jsonLines(updates), jsonLines(chat))
    },
  }
}

async function readSessionFile(directory: string, name: string): Promise<string> {
  try {
    const [folder, file] = await Promise.all([
      realpath(directory),
      realpath(path.join(directory, name)),
    ])
    if (path.dirname(file) !== folder || !(await stat(file)).isFile()) return ''
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function directories(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

function parseRecord(value: string) {
  try {
    return record(JSON.parse(value))
  } catch {
    return {}
  }
}

function jsonLines(value: string) {
  return value.split('\n').flatMap((line) => {
    const parsed = parseRecord(line)
    return Object.keys(parsed).length ? [parsed] : []
  })
}

function date(value: unknown, fallback: number) {
  const parsed =
    typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}
