import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, SearchSnippetPart, SessionSearchResult } from '@harness/contracts'
import { LoaderCircle, Search, X } from 'lucide-react'
import {
  agentPresentation,
  providerDisplayName,
  sourcePresentation,
  type ProviderPresentation,
} from '../provider-presentation.js'
import type { Transport } from '../transport.js'
import { SourceIdentity } from './SourceIdentity.js'
import { AppSelect } from './AppSelect.js'

const SEARCH_DEBOUNCE_MS = 80
const MAX_TITLE_RESULTS = 6
const SEARCH_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*/gu
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const PROVIDERS: ProviderId[] = [
  'codex',
  'claude-code',
  'grok',
  'cursor',
  'opencode',
  'antigravity',
  'pi',
  'acp',
  'api',
]

type SearchProject = {
  path: string
  name?: string | undefined
  sessions: Array<{
    id: string
    title: string
    provider: ProviderId
    agent?: string | undefined
    createdAt: number
  }>
}

type DisplaySearchResult = {
  key: string
  kind: 'title' | 'content'
  projectName: string
  threadId: string
  threadTitle: string
  provider: ProviderId
  source?: ProviderPresentation | undefined
  createdAt: number
  turnId: string | undefined
  titleParts: SearchSnippetPart[]
  snippet: SearchSnippetPart[] | undefined
}

function SessionSearchComponent(props: {
  transport: Transport
  projects: SearchProject[]
  initialProjectPath?: string | undefined
  onSelect: (threadId: string, turnId?: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [projectPath, setProjectPath] = useState(props.initialProjectPath ?? '')
  const [provider, setProvider] = useState<ProviderId | ''>('')
  const [results, setResults] = useState<SessionSearchResult[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [selectedKey, setSelectedKey] = useState<string>()
  const revision = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const resultList = useRef<HTMLDivElement>(null)
  const term = query.trim()
  const terms = useMemo(() => searchTerms(term), [term])
  const searchable = terms.length > 0

  const availableProviders = useMemo(() => {
    const present = new Set(
      props.projects.flatMap((project) => project.sessions.map((session) => session.provider)),
    )
    return PROVIDERS.filter((id) => present.has(id)).map((id) => ({
      id,
      label: providerDisplayName(id),
    }))
  }, [props.projects])

  const sources = useMemo(() => {
    const presentations = new Map<string, ProviderPresentation>()
    for (const project of props.projects) {
      for (const session of project.sessions) {
        if (session.provider === 'acp' && session.agent) {
          presentations.set(`${project.path}\0${session.id}`, agentPresentation(session.agent))
        }
      }
    }
    return presentations
  }, [props.projects])

  const titleResults = useMemo<DisplaySearchResult[]>(() => {
    if (!searchable) return []
    const normalizedQuery = terms.join(' ')
    const matches: Array<DisplaySearchResult & { rank: number }> = []

    for (const project of props.projects) {
      if (projectPath && project.path !== projectPath) continue
      const projectName = project.name ?? basename(project.path)
      for (const session of project.sessions) {
        if (provider && session.provider !== provider) continue
        const normalizedTitle = normalizeSearchText(session.title)
        if (!terms.every((part) => normalizedTitle.includes(part))) continue

        const rank =
          normalizedTitle === normalizedQuery
            ? 0
            : normalizedTitle.startsWith(normalizedQuery)
              ? 1
              : 2
        matches.push({
          key: `title:${JSON.stringify([project.path, session.id])}`,
          kind: 'title',
          projectName,
          threadId: session.id,
          threadTitle: session.title,
          provider: session.provider,
          source: sources.get(`${project.path}\0${session.id}`),
          createdAt: session.createdAt,
          turnId: undefined,
          titleParts: highlightText(session.title, terms),
          snippet: undefined,
          rank,
        })
      }
    }

    return matches
      .sort((left, right) => left.rank - right.rank || right.createdAt - left.createdAt)
      .slice(0, MAX_TITLE_RESULTS)
      .map(({ rank: _rank, ...result }) => result)
  }, [projectPath, props.projects, provider, searchable, sources, terms])

  const displayResults = useMemo<DisplaySearchResult[]>(() => {
    const legacyOccurrences = new Map<string, number>()
    return [
      ...titleResults,
      ...results.map((result) => ({
        key: contentResultKey(result, legacyOccurrences),
        kind: 'content' as const,
        projectName: result.projectName,
        threadId: result.threadId,
        threadTitle: result.threadTitle,
        provider: result.provider,
        source: sources.get(`${result.projectPath}\0${result.threadId}`),
        createdAt: result.createdAt,
        turnId: result.turnId,
        titleParts: [{ text: result.threadTitle, highlighted: false }],
        snippet: result.snippet,
      })),
    ]
  }, [results, sources, titleResults])
  const selected = useMemo(() => {
    if (displayResults.length === 0) return -1
    const index = displayResults.findIndex((result) => result.key === selectedKey)
    return index >= 0 ? index : 0
  }, [displayResults, selectedKey])

  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    if (provider && !availableProviders.some((entry) => entry.id === provider)) setProvider('')
  }, [availableProviders, provider])

  useEffect(() => {
    const current = ++revision.current
    setNextCursor(null)
    setError(undefined)
    setLoadingMore(false)
    if (!term || !searchable) {
      setResults([])
      setSearching(false)
      return
    }

    setSearching(true)
    const timer = window.setTimeout(() => {
      void props.transport
        .request('search.sessions', {
          query: term,
          limit: 20,
          ...(projectPath ? { projectPath } : {}),
          ...(provider || undefined ? { provider: provider || undefined } : {}),
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
          if (revision.current === current) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      if (revision.current === current) revision.current += 1
    }
  }, [props.transport, term, searchable, projectPath, provider, retry])

  useEffect(() => setSelectedKey(undefined), [term, projectPath, provider])

  useEffect(() => {
    if (selectedKey && !displayResults.some((result) => result.key === selectedKey)) {
      setSelectedKey(displayResults[0]?.key)
    }
  }, [displayResults, selectedKey])

  useEffect(() => {
    resultList.current
      ?.querySelector<HTMLElement>(`[data-search-index="${selected}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [displayResults.length, selected])

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    const current = revision.current
    setLoadingMore(true)
    setError(undefined)
    try {
      const page = await props.transport.request('search.sessions', {
        query: term,
        cursor: nextCursor,
        limit: 20,
        ...(projectPath ? { projectPath } : {}),
        ...(provider || undefined ? { provider: provider || undefined } : {}),
      })
      if (revision.current !== current) return
      setResults((existing) => [...existing, ...page.results])
      setNextCursor(page.nextCursor)
    } catch (cause) {
      if (revision.current === current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (revision.current === current) setLoadingMore(false)
    }
  }

  const choose = (result: DisplaySearchResult | undefined) => {
    if (result) props.onSelect(result.threadId, result.turnId)
  }

  return (
    <div
      className="command-palette session-search"
      role="dialog"
      aria-modal="true"
      aria-label="Search all chats"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
          return
        }
        if (event.key !== 'Tab') return

        const focusable = focusableElements(event.currentTarget)
        const currentIndex = focusable.findIndex((element) => element === document.activeElement)
        const atBoundary =
          currentIndex < 0 ||
          (event.shiftKey ? currentIndex === 0 : currentIndex === focusable.length - 1)
        if (!atBoundary) return
        event.preventDefault()
        ;(focusable[event.shiftKey ? focusable.length - 1 : 0] ?? event.currentTarget).focus()
      }}
    >
      <button
        className="command-palette__scrim"
        onClick={props.onClose}
        aria-label="Close search"
        tabIndex={-1}
      />
      <div className="command-palette__panel session-search__panel">
        <div className="command-palette__search">
          <Search size={15} aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (displayResults.length === 0) return
                const direction = event.key === 'ArrowDown' ? 1 : -1
                const next = (selected + direction + displayResults.length) % displayResults.length
                setSelectedKey(displayResults[next]?.key)
              } else if (event.key === 'Home' && displayResults.length > 0) {
                event.preventDefault()
                setSelectedKey(displayResults[0]?.key)
              } else if (event.key === 'End' && displayResults.length > 0) {
                event.preventDefault()
                setSelectedKey(displayResults.at(-1)?.key)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(displayResults[selected])
              }
            }}
            placeholder="Search every chat…"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-label="Search every chat"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="session-search-results"
            aria-activedescendant={
              displayResults[selected] ? `session-search-result-${selected}` : undefined
            }
          />
          {searching ? <LoaderCircle className="session-search__spinner" aria-hidden /> : null}
          <button className="icon-btn icon-btn--always" onClick={props.onClose} aria-label="Close">
            <X size={13} aria-hidden />
          </button>
        </div>
        <div className="session-search__filters">
          <label>
            <span>Project</span>
            <AppSelect
              ariaLabel="Project"
              value={projectPath}
              onChange={setProjectPath}
              options={[
                { value: '', label: 'All projects' },
                ...props.projects.map((project) => ({
                  value: project.path,
                  label: project.name ?? basename(project.path),
                })),
              ]}
            />
          </label>
          <label>
            <span>Agent</span>
            <AppSelect
              ariaLabel="Agent"
              value={provider}
              onChange={setProvider}
              options={[
                { value: '', label: 'All agents' },
                ...availableProviders.map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                })),
              ]}
            />
          </label>
        </div>
        <div
          ref={resultList}
          className="session-search__results"
          id="session-search-results"
          role="listbox"
          aria-label="Search results"
          aria-busy={searching}
        >
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
              Search chat titles, messages, commands, and tool output across projects.
            </p>
          ) : !searchable ? (
            <p className="command-palette__empty">Type a letter or number to search.</p>
          ) : (
            <>
              {displayResults.map((result, index) => {
                const startsGroup = index === 0 || displayResults[index - 1]?.kind !== result.kind
                return (
                  <div key={result.key} role="presentation">
                    {startsGroup ? (
                      <p className="session-search__group">
                        {result.kind === 'title' ? 'Chats' : 'Messages and output'}
                      </p>
                    ) : null}
                    <button
                      id={`session-search-result-${index}`}
                      data-search-index={index}
                      className={`session-search__result ${index === selected ? 'is-selected' : ''}`}
                      onClick={() => choose(result)}
                      onMouseEnter={() => setSelectedKey(result.key)}
                      onFocus={() => setSelectedKey(result.key)}
                      role="option"
                      aria-selected={index === selected}
                      aria-label={`${result.threadTitle}, ${result.kind === 'title' ? 'title match, ' : ''}${result.projectName}, ${resultProviderLabel(result)}`}
                    >
                      <span className="session-search__title">
                        {renderHighlightedParts(result.titleParts)}
                      </span>
                      <span className="session-search__meta">
                        {result.kind === 'title' ? (
                          <span className="session-search__match-kind">Title match</span>
                        ) : null}
                        <span>{result.projectName}</span>
                        <span aria-hidden>·</span>
                        <SourceIdentity
                          presentation={resultSourcePresentation(result)}
                          density="compact"
                        />
                        <span aria-hidden>·</span>
                        <time
                          dateTime={new Date(result.createdAt).toISOString()}
                          title={new Date(result.createdAt).toLocaleString()}
                        >
                          {formatResultDate(result.createdAt)}
                        </time>
                      </span>
                      {result.snippet ? (
                        <span className="session-search__snippet">
                          {renderHighlightedParts(result.snippet)}
                        </span>
                      ) : null}
                    </button>
                  </div>
                )
              })}
              {searching && displayResults.length === 0 ? (
                <p className="command-palette__empty" role="status">
                  Searching…
                </p>
              ) : null}
              {!searching && !error && displayResults.length === 0 ? (
                <p className="command-palette__empty" role="status">
                  No matches found.
                </p>
              ) : null}
              {nextCursor ? (
                <button
                  className="ghost session-search__more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Loading…' : 'Load more results'}
                </button>
              ) : null}
            </>
          )}
        </div>
        {searchable && displayResults.length > 0 ? (
          <div className="session-search__footer" role="status">
            <span>
              {searching ? 'Updating…' : `${displayResults.length}${nextCursor ? '+' : ''} shown`}
            </span>
            <span className="session-search__keys">
              <kbd>↑</kbd>
              <kbd>↓</kbd> navigate <kbd>↵</kbd> open
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'),
  )
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function contentResultKey(
  result: SessionSearchResult,
  legacyOccurrences: Map<string, number>,
): string {
  if (result.resultId) return `content:id:${result.resultId}`

  const identity = JSON.stringify([
    result.projectPath,
    result.projectName,
    result.threadId,
    result.threadTitle,
    result.turnId,
    result.provider,
    result.createdAt,
    result.snippet.map((part) => [part.text, part.highlighted]),
  ])
  const occurrence = legacyOccurrences.get(identity) ?? 0
  legacyOccurrences.set(identity, occurrence + 1)
  return `content:legacy:${JSON.stringify([identity, occurrence])}`
}

function resultSourcePresentation(result: DisplaySearchResult): ProviderPresentation {
  if (result.source) return result.source
  return sourcePresentation({
    provider: result.provider,
  })
}

function resultProviderLabel(result: DisplaySearchResult): string {
  return resultSourcePresentation(result).label
}

function searchTerms(query: string): string[] {
  return [...new Set(query.normalize('NFKC').toLowerCase().match(SEARCH_TOKEN) ?? [])]
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function highlightText(text: string, terms: string[]): SearchSnippetPart[] {
  const normalized = text.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  for (const term of terms) {
    let from = 0
    for (;;) {
      const start = normalized.indexOf(term, from)
      if (start < 0) break
      ranges.push({ start, end: start + term.length })
      from = start + term.length
    }
  }
  if (ranges.length === 0) return [{ text, highlighted: false }]

  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }

  const parts: SearchSnippetPart[] = []
  let cursor = 0
  for (const range of merged) {
    if (range.start > cursor)
      parts.push({ text: text.slice(cursor, range.start), highlighted: false })
    parts.push({ text: text.slice(range.start, range.end), highlighted: true })
    cursor = range.end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false })
  return parts
}

function renderHighlightedParts(parts: SearchSnippetPart[]) {
  return parts.map((part, index) =>
    part.highlighted ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
  )
}

function formatResultDate(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (sameDate(date, today)) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (sameDate(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(!(date.getFullYear() === today.getFullYear()) ? { year: 'numeric' } : {}),
  })
}

function sameDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

export const SessionSearch = memo(SessionSearchComponent)
