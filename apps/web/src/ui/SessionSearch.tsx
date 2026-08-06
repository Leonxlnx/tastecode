import { memo, useEffect, useRef, useState } from 'react'
import type { ProviderId, SessionSearchResult } from '@harness/contracts'
import { Search, X } from 'lucide-react'
import type { Transport } from '../transport.js'

// 'acp' is one filter because the server stores those sessions under one
// provider; the label names the agents the user knows, not our plumbing.
const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'acp', label: 'Gemini, Kimi & Qwen' },
]

function SessionSearchComponent(props: {
  transport: Transport
  projects: Array<{ path: string; name?: string | undefined }>
  initialProjectPath?: string | undefined
  onSelect: (threadId: string, turnId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [projectPath, setProjectPath] = useState(props.initialProjectPath ?? '')
  const [provider, setProvider] = useState<ProviderId | ''>('')
  const [results, setResults] = useState<SessionSearchResult[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const revision = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const term = query.trim()

  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    const current = ++revision.current
    setResults([])
    setNextCursor(null)
    setError(undefined)
    if (!term) {
      setLoading(false)
      return
    }
    const timer = window.setTimeout(() => {
      // Only once a request is actually in flight: setting it before the
      // debounce replaced the "search across projects" hint with
      // "Searching…" on the very first keystroke.
      setLoading(true)
      void props.transport
        .request('search.sessions', {
          query: term,
          limit: 20,
          ...(projectPath ? { projectPath } : {}),
          ...(provider ? { provider } : {}),
        })
        .then((page) => {
          if (revision.current !== current) return
          setResults(page.results)
          setNextCursor(page.nextCursor)
        })
        .catch((cause) => {
          if (revision.current === current)
            setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (revision.current === current) setLoading(false)
        })
    }, 220)
    return () => window.clearTimeout(timer)
  }, [props.transport, term, projectPath, provider, retry])

  const loadMore = async () => {
    if (!nextCursor || loading) return
    const current = revision.current
    setLoading(true)
    setError(undefined)
    try {
      const page = await props.transport.request('search.sessions', {
        query: term,
        cursor: nextCursor,
        limit: 20,
        ...(projectPath ? { projectPath } : {}),
        ...(provider ? { provider } : {}),
      })
      if (revision.current !== current) return
      setResults((existing) => [...existing, ...page.results])
      setNextCursor(page.nextCursor)
    } catch (cause) {
      if (revision.current === current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (revision.current === current) setLoading(false)
    }
  }

  return (
    <div
      className="command-palette session-search"
      role="dialog"
      aria-modal="true"
      aria-label="Search all chats"
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onClose()
      }}
    >
      <button
        className="command-palette__scrim"
        onClick={props.onClose}
        aria-label="Close search"
      />
      <div className="command-palette__panel session-search__panel">
        <div className="command-palette__search">
          <Search size={15} aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search every chat…"
            spellCheck={false}
            aria-label="Search every chat"
          />
          <button className="icon-btn icon-btn--always" onClick={props.onClose} aria-label="Close">
            <X size={13} aria-hidden />
          </button>
        </div>
        <div className="session-search__filters">
          <label>
            <span>Project</span>
            <select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
              <option value="">All projects</option>
              {props.projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.name ?? basename(project.path)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Agent</span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as ProviderId | '')}
            >
              <option value="">All agents</option>
              {PROVIDERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="session-search__results" aria-live="polite">
          {error ? (
            <div className="session-search__state" role="alert">
              <span>{error}</span>
              <button className="ghost" onClick={() => setRetry((value) => value + 1)}>
                Retry
              </button>
            </div>
          ) : null}
          {!term ? (
            <p className="command-palette__empty">
              Search messages and tool output across projects.
            </p>
          ) : results.length === 0 && !error ? (
            <p className="command-palette__empty">{loading ? 'Searching…' : 'No matches found.'}</p>
          ) : (
            results.map((result) => (
              <button
                className="session-search__result"
                key={`${result.threadId}:${result.turnId}:${result.createdAt}`}
                onClick={() => props.onSelect(result.threadId, result.turnId)}
              >
                <span className="session-search__title">{result.threadTitle}</span>
                <span className="session-search__meta">
                  {result.projectName} · {providerLabel(result.provider)} ·{' '}
                  {new Date(result.createdAt).toLocaleDateString()}
                </span>
                <span className="session-search__snippet">
                  {result.snippet.map((part, index) =>
                    part.highlighted ? (
                      <mark key={index}>{part.text}</mark>
                    ) : (
                      <span key={index}>{part.text}</span>
                    ),
                  )}
                </span>
              </button>
            ))
          )}
          {nextCursor ? (
            <button
              className="ghost session-search__more"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              {loading ? 'Loading…' : 'Load more results'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function providerLabel(provider: ProviderId): string {
  return PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider
}

export const SessionSearch = memo(SessionSearchComponent)
