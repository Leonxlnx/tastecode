import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type {
  ChatImportChat,
  ChatImportJob,
  ChatImportScan,
  ChatImportSource,
} from '@harness/contracts'
import {
  IconChevronRight as ChevronRight,
  IconFileImport as FileImport,
  IconRefresh as Refresh,
  IconSearch as Search,
} from '@tabler/icons-react'
import { providerMark, type ProviderMark } from '../model-catalog.js'
import type { Transport } from '../transport.js'
import {
  ALL_SOURCES,
  archivedCount,
  checkState,
  folderGroups,
  lastUsed,
  plural,
  selectionSummary,
  sourceCounts,
  toggled,
  type ImportFolderGroup,
} from './import-chats.js'
import { ProviderIcon } from './ProviderIcon.js'
import { Skeleton } from './Skeleton.js'
import {
  SettingsEmpty,
  SettingsEntitySkeleton,
  SettingsNotice,
  SettingsPage,
} from './settings/SettingsLayout.js'
import '../styles/import-settings.css'

/** A source still scanning is asked again this often. */
const RESCAN_MS = 2_000

function sourceMark(source: ChatImportSource | undefined): ProviderMark | undefined {
  if (source?.provider) return providerMark(source.provider)
  return source?.id === 't3-code' ? 't3code' : undefined
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function ImportSettings(props: {
  transport: Transport
  onOpenChat: (threadId: string) => void
}) {
  const { transport } = props
  const [scan, setScan] = useState<ChatImportScan>()
  const [failure, setFailure] = useState<string>()
  const [rescanning, setRescanning] = useState(false)
  const [source, setSource] = useState(ALL_SOURCES)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [job, setJob] = useState<ChatImportJob>()
  const [startFailure, setStartFailure] = useState<string>()
  const [now] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const next = await transport.request('chatImport.scan', {})
      setScan(next)
      setFailure(undefined)
      // A finished import from an earlier visit is not news on this one.
      if (next.job?.state === 'running') setJob(next.job)
    } catch (cause) {
      setFailure(message(cause))
    }
  }, [transport])

  useEffect(() => {
    void load()
  }, [load])

  const scanning = scan?.sources.some(({ state }) => state === 'scanning') ?? false
  useEffect(() => {
    if (!scanning) return
    const timer = setTimeout(() => void load(), RESCAN_MS)
    return () => clearTimeout(timer)
  }, [scan, scanning, load])

  useEffect(
    () =>
      transport.on('chatImport.progress', (next) => {
        setJob(next)
        if (next.state !== 'finished') return
        setSelected(new Set())
        void load()
      }),
    [transport, load],
  )

  const rescan = async () => {
    setRescanning(true)
    setJob(undefined)
    await load()
    setRescanning(false)
  }

  const start = async (ids: string[]) => {
    setStartFailure(undefined)
    setJob(undefined)
    try {
      const started = await transport.request('chatImport.start', { chats: ids })
      // The last report can arrive before this reply on a small import.
      setJob((current) => current ?? started)
    } catch (cause) {
      setStartFailure(message(cause))
    }
  }

  const running = job?.state === 'running'
  const refresh = (
    <button
      className="set-button set-button--quiet"
      type="button"
      disabled={rescanning || running || scan === undefined}
      onClick={() => void rescan()}
    >
      <Refresh size={14} aria-hidden />
      Scan again
    </button>
  )

  return (
    <SettingsPage
      className="import-page"
      title="Import chats"
      description="Bring in chats from other coding apps. Their originals are never changed."
      actions={refresh}
    >
      {failure ? (
        <SettingsNotice
          tone="error"
          action={
            <button className="set-button" type="button" onClick={() => void rescan()}>
              Try again
            </button>
          }
        >
          Could not look for chats. {failure}
        </SettingsNotice>
      ) : null}
      {scan === undefined && !failure ? (
        <SettingsEntitySkeleton label="Looking for chats on this computer…" rows={4} />
      ) : null}
      {scan ? (
        <ImportList
          scan={scan}
          scanning={scanning}
          source={source}
          query={query}
          archived={archived}
          selected={selected}
          open={open}
          job={job}
          startFailure={startFailure}
          now={now}
          onSource={setSource}
          onQuery={setQuery}
          onArchived={setArchived}
          onSelected={setSelected}
          onOpen={setOpen}
          onStart={(ids) => void start(ids)}
          onOpenChat={props.onOpenChat}
        />
      ) : null}
    </SettingsPage>
  )
}

function ImportList(props: {
  scan: ChatImportScan
  scanning: boolean
  source: string
  query: string
  archived: boolean
  selected: ReadonlySet<string>
  open: ReadonlySet<string>
  job: ChatImportJob | undefined
  startFailure: string | undefined
  now: number
  onSource: (source: string) => void
  onQuery: (query: string) => void
  onArchived: (archived: boolean) => void
  onSelected: (selected: ReadonlySet<string>) => void
  onOpen: (open: ReadonlySet<string>) => void
  onStart: (ids: string[]) => void
  onOpenChat: (threadId: string) => void
}) {
  const { scan, selected, open, job } = props
  // A source that left the list since it was picked falls back to all of them.
  const source = scan.sources.some(({ id }) => id === props.source) ? props.source : ALL_SOURCES
  const counts = useMemo(() => sourceCounts(scan, props.archived), [scan, props.archived])
  const groups = useMemo(
    () => folderGroups(scan, { source, query: props.query, archived: props.archived }),
    [scan, source, props.query, props.archived],
  )
  const shown = useMemo(() => groups.flatMap(({ chats }) => chats), [groups])
  const summary = useMemo(() => selectionSummary(scan, selected), [scan, selected])
  const sources = useMemo(() => new Map(scan.sources.map((item) => [item.id, item])), [scan])
  const hidden = archivedCount(scan)
  const searching = props.query.trim().length > 0
  const running = job?.state === 'running'
  const failed = scan.sources.filter(({ state }) => state === 'failed')
  const copies = shown.some(({ continuation }) => continuation === 'copy')
  const nothingLeft = !counts.get(ALL_SOURCES) && !job && !summary.chats

  if (!scan.sources.length) {
    return (
      <SettingsEmpty
        icon={<FileImport size={20} aria-hidden />}
        title="No chats to import"
        detail="TasteCode found nothing from T3 Code, Claude Code, Codex, Grok or OpenCode on this computer."
      />
    )
  }

  const toggleOpen = (folder: string) => {
    const next = new Set(open)
    if (!next.delete(folder)) next.add(folder)
    props.onOpen(next)
  }

  return (
    <div className="import-list">
      {props.startFailure ? (
        <SettingsNotice tone="error">{props.startFailure}</SettingsNotice>
      ) : null}
      {failed.length ? (
        <SettingsNotice tone="error">
          {failed.map(({ name }) => name).join(' and ')} could not be read. Other apps are not
          affected.
        </SettingsNotice>
      ) : null}

      <SourceStrip
        sources={scan.sources}
        value={source}
        counts={counts}
        onChange={props.onSource}
      />

      <div className="import-tools">
        <div className="import-search">
          <Search size={14} aria-hidden />
          <input
            className="set-input"
            type="search"
            placeholder="Search chats"
            aria-label="Search chats and folders"
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
          />
          {searching ? (
            <button
              className="set-button set-button--quiet import-search__clear"
              type="button"
              aria-label="Clear search"
              onClick={(event) => {
                props.onQuery('')
                event.currentTarget.parentElement?.querySelector('input')?.focus()
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
        {hidden ? (
          <label className="import-archived">
            <input
              className="import-check"
              type="checkbox"
              checked={props.archived}
              onChange={(event) => props.onArchived(event.target.checked)}
            />
            Include {plural(hidden, 'archived chat')}
          </label>
        ) : null}
      </div>

      {groups.length ? (
        <>
          <SelectAll
            chats={shown}
            selected={selected}
            disabled={running}
            onChange={props.onSelected}
          />
          <ul className="import-folders" aria-label="Folders with chats to import">
            {groups.map((group) => (
              <FolderRow
                key={group.folder.path}
                group={group}
                open={searching || open.has(group.folder.path)}
                searching={searching}
                selected={selected}
                sources={sources}
                now={props.now}
                disabled={running}
                onToggleOpen={() => toggleOpen(group.folder.path)}
                onChange={props.onSelected}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="import-none" role="status">
          {searching
            ? 'No chats match that search.'
            : props.scanning
              ? 'Still looking through saved chats…'
              : 'Every chat here is already in TasteCode.'}
        </p>
      )}

      {copies ? (
        <p className="import-note">
          A chat marked Copy starts a new session that gets its transcript with your next message.
          The others pick up their own saved session.
        </p>
      ) : null}

      {nothingLeft ? null : (
        <ImportBar
          job={job}
          chats={summary.chats}
          folders={summary.folders}
          newProjects={summary.newProjects}
          onStart={() => props.onStart(summary.ids)}
          onOpenChat={props.onOpenChat}
        />
      )}
    </div>
  )
}

function finishedLine(job: ChatImportJob): string {
  const unread = job.failed ? `${plural(job.failed, 'chat')} could not be read.` : ''
  if (!job.imported) return unread
  const projects = job.projects.length
  const added = projects ? `, adding ${plural(projects, 'project')}` : ''
  return `Imported ${plural(job.imported, 'chat')}${added}.${unread ? ` ${unread}` : ''}`
}

/** What is on this computer, and the list's filter: one figure per app. */
function SourceStrip(props: {
  sources: readonly ChatImportSource[]
  value: string
  counts: ReadonlyMap<string, number>
  onChange: (source: string) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const options = [{ id: ALL_SOURCES, name: 'All apps' } as const, ...props.sources]
  const chosen = Math.max(
    0,
    options.findIndex(({ id }) => id === props.value),
  )
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = options.length
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % count
    else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    buttons.current[next]?.focus()
    props.onChange(options[next]!.id)
  }
  return (
    <div className="import-sources" role="radiogroup" aria-label="Filter by app">
      {options.map((option, index) => {
        const state = 'state' in option ? option.state : 'ready'
        const mark = 'state' in option ? sourceMark(option) : undefined
        return (
          <button
            key={option.id}
            ref={(element) => {
              buttons.current[index] = element
            }}
            className="import-source"
            type="button"
            role="radio"
            aria-checked={index === chosen}
            tabIndex={index === chosen ? 0 : -1}
            onClick={() => props.onChange(option.id)}
            onKeyDown={(event) => move(event, index)}
          >
            <span className="import-source__name">
              {mark ? <ProviderIcon mark={mark} size={13} /> : null}
              {option.name}
            </span>
            {state === 'scanning' ? (
              <Skeleton className="import-source__pending" width={28} height={20} />
            ) : (
              <span className="import-source__count" data-failed={state === 'failed' || undefined}>
                {state === 'failed' ? '–' : (props.counts.get(option.id) ?? 0).toLocaleString()}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function TriCheck(props: {
  label: string
  state: 'none' | 'some' | 'all'
  disabled?: boolean | undefined
  onChange: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (input.current) input.current.indeterminate = props.state === 'some'
  }, [props.state])
  return (
    <input
      ref={input}
      className="import-check"
      type="checkbox"
      aria-label={props.label}
      checked={props.state === 'all'}
      disabled={props.disabled}
      onChange={props.onChange}
    />
  )
}

function SelectAll(props: {
  chats: readonly ChatImportChat[]
  selected: ReadonlySet<string>
  disabled: boolean
  onChange: (selected: ReadonlySet<string>) => void
}) {
  const { state, chosen } = checkState(props.chats, props.selected)
  return (
    <div className="import-all">
      <label className="import-all__label">
        <TriCheck
          label={`Select all ${plural(props.chats.length, 'chat')}`}
          state={state}
          disabled={props.disabled}
          onChange={() => props.onChange(toggled(props.selected, props.chats))}
        />
        Select all
      </label>
      <span className="import-all__count">
        {chosen
          ? `${chosen.toLocaleString()} of ${plural(props.chats.length, 'chat')}`
          : plural(props.chats.length, 'chat')}
      </span>
    </div>
  )
}

function folderState(group: ImportFolderGroup): string {
  if (group.folder.missing) return 'Folder is gone'
  return group.folder.isProject ? 'In your projects' : 'New project'
}

function FolderRow(props: {
  group: ImportFolderGroup
  open: boolean
  searching: boolean
  selected: ReadonlySet<string>
  sources: ReadonlyMap<string, ChatImportSource>
  now: number
  disabled: boolean
  onToggleOpen: () => void
  onChange: (selected: ReadonlySet<string>) => void
}) {
  const { group, open, selected } = props
  const { state, chosen } = checkState(group.chats, selected)
  const panel = useId()
  return (
    <li className="import-folder" data-open={open || undefined}>
      <div className="import-folder__row">
        <TriCheck
          label={`Select all chats in ${group.folder.name}`}
          state={state}
          disabled={props.disabled}
          onChange={() => props.onChange(toggled(selected, group.chats))}
        />
        <button
          className="import-folder__toggle"
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          disabled={props.searching}
          onClick={props.onToggleOpen}
        >
          <ChevronRight className="import-folder__chevron" size={14} aria-hidden />
          <span className="import-folder__text">
            <span className="import-folder__head">
              <span className="import-folder__name">{group.folder.name}</span>
              <span className="set-leader" aria-hidden />
              <span className="import-folder__count">
                {chosen
                  ? `${chosen.toLocaleString()} of ${plural(group.chats.length, 'chat')}`
                  : plural(group.chats.length, 'chat')}
              </span>
              <span className="import-folder__when">{lastUsed(group.updatedAt, props.now)}</span>
            </span>
            <span className="import-folder__meta">
              <span className="import-folder__path" title={group.folder.path}>
                {group.folder.label}
              </span>
              <span
                className="import-folder__state"
                data-state={group.folder.missing ? 'missing' : undefined}
              >
                {folderState(group)}
              </span>
            </span>
          </span>
        </button>
      </div>
      {open ? (
        <ul className="import-chats" id={panel}>
          {group.chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              checked={selected.has(chat.id)}
              source={props.sources.get(chat.source)}
              alsoIn={chat.alsoIn?.map((id) => props.sources.get(id)?.name ?? id)}
              now={props.now}
              disabled={props.disabled}
              onChange={() => props.onChange(toggled(selected, [chat]))}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function ChatRow(props: {
  chat: ChatImportChat
  checked: boolean
  source: ChatImportSource | undefined
  alsoIn: string[] | undefined
  now: number
  disabled: boolean
  onChange: () => void
}) {
  const { chat } = props
  const mark = sourceMark(props.source)
  const title = chat.title || 'Untitled chat'
  const savedBy = [props.source?.name, ...(props.alsoIn ?? [])].filter(Boolean).join(' and ')
  const meta = [
    ...(chat.archived ? ['Archived'] : []),
    ...(chat.continuation === 'copy' ? ['Copy'] : []),
    lastUsed(chat.updatedAt, props.now),
  ]
  return (
    <li className="import-chat">
      <label className="import-chat__label">
        <input
          className="import-check"
          type="checkbox"
          aria-label={title}
          checked={props.checked}
          disabled={props.disabled}
          onChange={props.onChange}
        />
        <span className="import-chat__mark" title={savedBy}>
          {mark ? <ProviderIcon mark={mark} size={13} /> : null}
        </span>
        <span className="import-chat__title">{title}</span>
        <span className="set-leader" aria-hidden />
        <span className="import-chat__meta">{meta.join(' · ')}</span>
      </label>
    </li>
  )
}

function ImportBar(props: {
  job: ChatImportJob | undefined
  chats: number
  folders: number
  newProjects: number
  onStart: () => void
  onOpenChat: (threadId: string) => void
}) {
  const { job } = props
  if (job?.state === 'running') {
    return (
      <div className="import-bar" role="status">
        <span className="import-bar__summary">
          Importing {job.done.toLocaleString()} of {plural(job.total, 'chat')}
        </span>
        <span
          className="import-bar__track"
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={job.total}
          aria-valuenow={job.done}
        >
          <span
            className="import-bar__fill"
            style={{ transform: `scaleX(${job.total ? job.done / job.total : 0})` }}
          />
        </span>
      </div>
    )
  }
  if (job?.state === 'finished' && !props.chats) {
    const thread = job.thread
    return (
      <div className="import-bar" role="status">
        <span className="import-bar__summary">{finishedLine(job)}</span>
        {thread ? (
          <button
            className="set-button set-button--primary"
            type="button"
            onClick={() => props.onOpenChat(thread)}
          >
            Open newest chat
          </button>
        ) : null}
      </div>
    )
  }
  const parts = props.chats
    ? [
        `${plural(props.chats, 'chat')} from ${plural(props.folders, 'folder')}`,
        ...(props.newProjects ? [plural(props.newProjects, 'new project')] : []),
      ]
    : ['Choose the chats to bring in']
  return (
    <div className="import-bar">
      <span className="import-bar__summary" data-empty={!props.chats || undefined}>
        {parts.join(' · ')}
      </span>
      <button
        className="set-button set-button--primary"
        type="button"
        disabled={!props.chats}
        onClick={props.onStart}
      >
        {props.chats ? `Import ${plural(props.chats, 'chat')}` : 'Import'}
      </button>
    </div>
  )
}
