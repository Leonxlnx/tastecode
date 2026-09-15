import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  PullRequestDetail,
  PullRequestListItem,
  PullRequestListResult,
} from '@harness/contracts'
import {
  IconChevronLeft as ChevronLeft,
  IconAlertCircle as CircleAlert,
  IconFolderCode as FolderGit2,
  IconGitBranch as GitBranch,
  IconGitMerge as GitMerge,
  IconGitPullRequest as GitPullRequest,
  IconGitPullRequestClosed as GitPullRequestClosed,
  IconGitPullRequestDraft as GitPullRequestDraft,
  IconInbox as Inbox,
  IconFilter as ListFilter,
  IconMessageDots as MessageSquareText,
  IconRefresh as RefreshCw,
  IconRotate as RotateCcw,
  IconSearch as Search,
  IconUser as UserRound,
  type TablerIcon,
} from '@tabler/icons-react'
import type { Transport } from '../../transport.js'
import { errorMessage as messageOf } from '../../boundary.js'
import {
  beginGitHubSetup,
  githubSetupKey,
  type GitHubSetupAction,
  type ProviderLoginTerminalTarget,
} from '../../provider-install.js'
import { Menu, MenuItem } from '../Menu.js'
import { Skeleton } from '../Skeleton.js'
import { PullRequestDetailPane } from './PullRequestDetailPane.js'
import { countPullRequestFilterValues } from './pull-request-filter-values.js'
import { comparePullRequestText } from './pull-request-text.js'
import './pull-requests.css'

type PullRequestFilter = 'all' | 'reviewing' | 'authored'
type PullRequestStatusFilter = 'all' | 'open' | 'draft' | 'merged' | 'closed'
type PullRequestReviewFilter = 'all' | 'required' | 'approved' | 'changes-requested' | 'none'
type PullRequestMergeFilter = 'all' | 'ready' | 'conflicts' | 'blocked' | 'behind'
type PullRequestFilterCategory = 'status' | 'review' | 'merge' | 'repository' | 'author' | 'base'
type PullRequestFilters = {
  status: PullRequestStatusFilter
  review: PullRequestReviewFilter
  merge: PullRequestMergeFilter
  repository: string | undefined
  author: string | undefined
  base: string | undefined
}

const PULL_REQUEST_FILTER_CATEGORIES: ReadonlyArray<{
  value: PullRequestFilterCategory
  label: string
  icon: TablerIcon
}> = [
  { value: 'status', label: 'State', icon: GitPullRequest },
  { value: 'review', label: 'Review', icon: MessageSquareText },
  { value: 'merge', label: 'Merge status', icon: GitMerge },
  { value: 'repository', label: 'Repository', icon: FolderGit2 },
  { value: 'author', label: 'Author', icon: UserRound },
  { value: 'base', label: 'Base branch', icon: GitBranch },
]

const DEFAULT_PULL_REQUEST_FILTERS: PullRequestFilters = {
  status: 'all',
  review: 'all',
  merge: 'all',
  repository: undefined,
  author: undefined,
  base: undefined,
}
const LIST_REVALIDATE_AFTER_MS = 30_000

export function PullRequestsView(props: {
  transport: Transport
  onOpenChat: (pullRequest: PullRequestListItem) => void
  onSetupTerminalOpen: (target: ProviderLoginTerminalTarget) => void
  setupRefreshRevision?: number | undefined
}) {
  const [result, setResult] = useState<PullRequestListResult>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<PullRequestFilter>('all')
  const [filters, setFilters] = useState<PullRequestFilters>(DEFAULT_PULL_REQUEST_FILTERS)
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string>()
  const [setupStarting, setSetupStarting] = useState(false)
  const [setupError, setSetupError] = useState<string>()
  const request = useRef(0)

  const load = useCallback(
    async (refresh = false): Promise<PullRequestListResult | undefined> => {
      const id = ++request.current
      if (refresh) setRefreshing(true)
      else setLoading(true)
      setError(undefined)
      try {
        const next = await props.transport.request('pullRequests.list', { refresh })
        if (id !== request.current) return
        setResult(next)
        setSelectedKey((current) =>
          current && next.items.some((item) => pullRequestKey(item) === current)
            ? current
            : next.items[0]
              ? pullRequestKey(next.items[0])
              : undefined,
        )
        return next
      } catch (cause) {
        if (id === request.current) setError(messageOf(cause))
      } finally {
        if (id === request.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
      return undefined
    },
    [props.transport],
  )

  useEffect(() => {
    void load().then((next) => {
      if (next && Date.now() - next.fetchedAt > LIST_REVALIDATE_AFTER_MS) void load(true)
    })
    return () => {
      request.current += 1
    }
  }, [load])

  useEffect(() => {
    if ((props.setupRefreshRevision ?? 0) > 0) void load(true)
  }, [load, props.setupRefreshRevision])

  const normalizedQuery = query.trim().toLowerCase()
  const relationshipItems = useMemo(
    () =>
      (result?.items ?? []).filter(
        (item) => filter === 'all' || item.relationship === filter || item.relationship === 'both',
      ),
    [filter, result?.items],
  )
  const visible = useMemo(
    () =>
      relationshipItems.filter((item) => {
        if (!matchesPullRequestFilters(item, filters)) return false
        if (!normalizedQuery) return true
        return [
          item.title,
          item.repository,
          item.author.login,
          item.headRefName,
          item.baseRefName,
          String(item.number),
          listStateLabel(item),
        ].some((value) => value.toLowerCase().includes(normalizedQuery))
      }),
    [filters, normalizedQuery, relationshipItems],
  )

  useEffect(() => {
    if (visible.length === 0) return
    if (!visible.some((item) => pullRequestKey(item) === selectedKey)) {
      setSelectedKey(pullRequestKey(visible[0]!))
    }
  }, [selectedKey, visible])

  const syncDetail = useCallback((next: PullRequestDetail) => {
    setResult((current) => {
      if (!current) return current
      const key = pullRequestKey(next)
      return {
        ...current,
        items: current.items
          .map((item) => (pullRequestKey(item) === key ? listItemFromDetail(next) : item))
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      }
    })
  }, [])

  const selected = visible.find((item) => pullRequestKey(item) === selectedKey)
  const counts = useMemo(() => {
    const filteredItems = (result?.items ?? []).filter((item) =>
      matchesPullRequestFilters(item, filters),
    )
    return {
      all: filteredItems.length,
      reviewing: filteredItems.filter(
        (item) => item.relationship === 'reviewing' || item.relationship === 'both',
      ).length,
      authored: filteredItems.filter(
        (item) => item.relationship === 'authored' || item.relationship === 'both',
      ).length,
    }
  }, [filters, result?.items])
  const activeFilterCount = countActivePullRequestFilters(filters)
  const githubSetupAction: GitHubSetupAction = result?.account.available ? 'login' : 'install'

  const startGitHubSetup = () => {
    setSetupStarting(true)
    setSetupError(undefined)
    void beginGitHubSetup(props.transport, githubSetupAction)
      .then(() => {
        props.onSetupTerminalOpen({
          displayName: githubSetupAction === 'install' ? 'GitHub CLI' : 'GitHub',
          installKey: githubSetupKey(githubSetupAction),
          operation: githubSetupAction,
          source: 'pull-requests',
        })
      })
      .catch((cause: unknown) => setSetupError(messageOf(cause)))
      .finally(() => setSetupStarting(false))
  }

  return (
    <section className="pr-workspace" aria-label="Pull requests">
      <aside className="pr-list-pane">
        <header className="pr-list-head">
          <div className="pr-list-title-row">
            <div>
              <h1>Pull requests</h1>
              <span>{result?.account.login ? `@${result.account.login}` : 'GitHub'}</span>
            </div>
            <button
              type="button"
              className="pr-icon-button"
              aria-label="Refresh pull requests"
              title="Refresh pull requests"
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              <RefreshCw size={14} className={refreshing ? 'is-spinning' : undefined} aria-hidden />
            </button>
          </div>

          <div className="pr-segment" role="tablist" aria-label="Pull request relationship">
            {(['all', 'reviewing', 'authored'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                className={filter === value ? 'is-active' : undefined}
                onClick={() => setFilter(value)}
              >
                {capitalize(value)}
                <span>{counts[value]}</span>
              </button>
            ))}
          </div>

          <div className="pr-search-row">
            <label className="pr-search">
              <Search size={14} aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pull requests"
                aria-label="Search pull requests"
              />
            </label>
            <PullRequestFilterMenu
              value={filters}
              items={relationshipItems}
              onChange={setFilters}
            />
          </div>
        </header>

        <div className="pr-list-scroll">
          {loading ? (
            <PullRequestListSkeleton />
          ) : error && !result ? (
            <ListMessage
              icon={<CircleAlert size={18} aria-hidden />}
              title="Couldn't load pull requests"
              detail={error}
              action="Try again"
              onAction={() => void load(true)}
            />
          ) : !result?.account.authenticated ? (
            <ListMessage
              icon={<GitPullRequest size={19} aria-hidden />}
              title={result?.account.available ? 'Connect GitHub' : 'Install GitHub CLI'}
              detail={
                setupError ??
                result?.account.error ??
                'TasteCode uses your local GitHub CLI session and never reads its token.'
              }
              action={
                setupStarting
                  ? 'Starting…'
                  : result?.account.available
                    ? 'Sign in'
                    : 'Install GitHub CLI'
              }
              actionDisabled={setupStarting}
              onAction={startGitHubSetup}
            />
          ) : visible.length === 0 ? (
            <ListMessage
              icon={<Inbox size={19} aria-hidden />}
              title={
                normalizedQuery || activeFilterCount > 0
                  ? 'No matching pull requests'
                  : 'No pull requests'
              }
              detail={
                normalizedQuery
                  ? 'Try a title, repository, author, branch, status, or pull-request number.'
                  : activeFilterCount > 0
                    ? 'Clear or change one of the active filters.'
                    : filter === 'reviewing'
                      ? 'Nothing is waiting for your review.'
                      : 'Authored, review-requested, and reviewed pull requests will appear here.'
              }
            />
          ) : (
            <>
              <PullRequestGroup
                title={filter === 'all' ? undefined : capitalize(filter)}
                items={visible}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
              />
              {result.truncated ? (
                <p className="pr-list-note">
                  GitHub capped one or more searches, so some older pull requests may be omitted.
                </p>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <div className="pr-detail-pane">
        {selected ? (
          <PullRequestDetailPane
            key={pullRequestKey(selected)}
            item={selected}
            transport={props.transport}
            onOpenChat={() => props.onOpenChat(selected)}
            onChanged={syncDetail}
          />
        ) : (
          <div className="pr-detail-empty">
            <span className="pr-empty-emblem">
              <GitPullRequest size={22} aria-hidden />
            </span>
            <strong>Select a pull request</strong>
            <p>Summary, files, review conversations, checks, and merge controls live here.</p>
          </div>
        )}
      </div>
    </section>
  )
}

function PullRequestGroup(props: {
  title: string | undefined
  items: PullRequestListItem[]
  selectedKey: string | undefined
  onSelect: (key: string) => void
}) {
  return (
    <section className="pr-list-group">
      {props.title ? <h2>{props.title}</h2> : null}
      <div className="pr-list-items">
        {props.items.map((item) => {
          const key = pullRequestKey(item)
          return (
            <PullRequestListRow
              key={key}
              item={item}
              selected={props.selectedKey === key}
              onSelect={props.onSelect}
            />
          )
        })}
      </div>
    </section>
  )
}

const PullRequestListRow = memo(function PullRequestListRow(props: {
  item: PullRequestListItem
  selected: boolean
  onSelect: (key: string) => void
}) {
  const key = pullRequestKey(props.item)
  const state = listStatus(props.item)
  const stateLabel = listStateLabel(props.item)
  return (
    <button
      type="button"
      className={`pr-list-item${props.selected ? ' is-selected' : ''}`}
      aria-current={props.selected ? 'true' : undefined}
      onClick={() => props.onSelect(key)}
    >
      <span className={`pr-state-mark is-${state}`} aria-label={stateLabel} title={stateLabel}>
        {props.item.isDraft ? (
          <GitPullRequestDraft size={15} aria-hidden />
        ) : props.item.state === 'MERGED' ? (
          <GitMerge size={15} aria-hidden />
        ) : props.item.state === 'CLOSED' ? (
          <GitPullRequestClosed size={15} aria-hidden />
        ) : (
          <GitPullRequest size={15} aria-hidden />
        )}
      </span>
      <span className="pr-list-copy">
        <span className="pr-list-item-head">
          <strong>{props.item.title}</strong>
          <time dateTime={props.item.updatedAt}>{relativeTime(props.item.updatedAt)}</time>
        </span>
        <span className="pr-list-meta">
          <span>{props.item.repository}</span>
          <span>#{props.item.number}</span>
          {props.item.isDraft || props.item.state !== 'OPEN' ? (
            <span className={`pr-list-state is-${state}`}>{stateLabel}</span>
          ) : null}
          {props.item.headRefName ? (
            <span className="pr-list-branch">{props.item.headRefName}</span>
          ) : null}
        </span>
      </span>
      {props.item.headRefName ? (
        <span
          className="pr-list-stats"
          aria-label={`${props.item.additions} additions and ${props.item.deletions} deletions`}
        >
          <span className="is-addition">+{formatCount(props.item.additions)}</span>
          <span className="is-deletion">−{formatCount(props.item.deletions)}</span>
        </span>
      ) : null}
    </button>
  )
})

function PullRequestFilterMenu(props: {
  value: PullRequestFilters
  items: PullRequestListItem[]
  onChange: (value: PullRequestFilters) => void
}) {
  const [category, setCategory] = useState<PullRequestFilterCategory>()
  const activeCount = countActivePullRequestFilters(props.value)
  const selectedCategory = PULL_REQUEST_FILTER_CATEGORIES.find((entry) => entry.value === category)
  const SelectedCategoryIcon = selectedCategory?.icon
  const options = selectedCategory
    ? pullRequestFilterOptions(selectedCategory.value, props.items, props.value)
    : []

  return (
    <Menu
      align="right"
      drop="down"
      label={`Filter pull requests: ${activeCount === 0 ? 'no active filters' : `${activeCount} active ${activeCount === 1 ? 'filter' : 'filters'}`}`}
      triggerClassName={`pr-list-filter${activeCount === 0 ? '' : ' is-active'}`}
      panelLabel="Pull request filters"
      panelClassName="pr-filter-menu"
      trigger={() => (
        <span>
          <ListFilter size={13} aria-hidden />
          {activeCount === 0 ? 'Filters' : `${activeCount} active`}
        </span>
      )}
    >
      {() => (
        <>
          {selectedCategory ? (
            <>
              <MenuItem
                title="All filters"
                detail={selectedCategory.label}
                icon={<ChevronLeft size={13} aria-hidden />}
                onClick={() => setCategory(undefined)}
              />
              <div className="menu__rule" />
              {options.map((option) => (
                <MenuItem
                  key={option.key}
                  title={option.label}
                  icon={
                    SelectedCategoryIcon ? (
                      <SelectedCategoryIcon size={14} aria-hidden />
                    ) : (
                      <ListFilter size={14} aria-hidden />
                    )
                  }
                  detail={`${option.count.toLocaleString()} pull requests`}
                  active={option.selected}
                  onClick={() => {
                    props.onChange(option.next)
                    setCategory(undefined)
                  }}
                />
              ))}
            </>
          ) : (
            <>
              <div className="pr-filter-menu-head">
                <strong>Filter by</strong>
                <button
                  type="button"
                  role="menuitem"
                  disabled={activeCount === 0}
                  onClick={() => props.onChange(DEFAULT_PULL_REQUEST_FILTERS)}
                >
                  <RotateCcw size={12} aria-hidden />
                  <span>Clear all</span>
                </button>
              </div>
              {PULL_REQUEST_FILTER_CATEGORIES.map((entry) => {
                const selection = pullRequestFilterSelectionLabel(entry.value, props.value)
                const CategoryIcon = entry.icon
                return (
                  <MenuItem
                    key={entry.value}
                    title={entry.label}
                    icon={<CategoryIcon size={14} aria-hidden />}
                    detail={selection}
                    active={pullRequestFilterCategoryIsActive(entry.value, props.value)}
                    onClick={() => setCategory(entry.value)}
                  />
                )
              })}
            </>
          )}
        </>
      )}
    </Menu>
  )
}

function PullRequestListSkeleton() {
  return (
    <div className="pr-list-skeleton skeleton-group" aria-label="Loading pull requests">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <span className="pr-skeleton-row" key={index}>
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </span>
      ))}
    </div>
  )
}

function ListMessage(props: {
  icon: ReactNode
  title: string
  detail: string
  action?: string
  href?: string
  onAction?: () => void
  actionDisabled?: boolean
}) {
  return (
    <div className="pr-list-message">
      <span className="pr-empty-emblem">{props.icon}</span>
      <strong>{props.title}</strong>
      <p>{props.detail}</p>
      {props.action && props.href ? (
        <a className="pr-button is-secondary" href={props.href} target="_blank" rel="noreferrer">
          {props.action}
        </a>
      ) : props.action ? (
        <button
          type="button"
          className="pr-button is-secondary"
          disabled={props.actionDisabled}
          onClick={props.onAction}
        >
          {props.action}
        </button>
      ) : null}
    </div>
  )
}

function listItemFromDetail(detail: PullRequestDetail): PullRequestListItem {
  return {
    id: detail.id,
    repository: detail.repository,
    number: detail.number,
    title: detail.title,
    url: detail.url,
    author: detail.author,
    updatedAt: detail.updatedAt,
    isDraft: detail.isDraft,
    state: detail.state,
    additions: detail.additions,
    deletions: detail.deletions,
    commentsCount: detail.commentsCount,
    headRefName: detail.headRefName,
    baseRefName: detail.baseRefName,
    ...(detail.reviewDecision
      ? {
          reviewDecision: detail.reviewDecision,
        }
      : {}),
    ...(detail.mergeStateStatus
      ? {
          mergeStateStatus: detail.mergeStateStatus,
        }
      : {}),
    relationship: detail.relationship,
    ...(detail.localProjectPath
      ? {
          localProjectPath: detail.localProjectPath,
        }
      : {}),
  }
}

function pullRequestKey(item: PullRequestListItem): string {
  return `${item.repository.toLowerCase()}#${item.number}`
}

function listStatus(item: PullRequestListItem): string {
  if (item.isDraft && item.state === 'CLOSED') return 'closed-draft'
  if (item.isDraft) return 'draft'
  if (item.state === 'MERGED') return 'merged'
  if (item.state === 'CLOSED') return 'closed'
  if (item.mergeStateStatus === 'DIRTY') return 'conflict'
  if (item.reviewDecision === 'CHANGES_REQUESTED') return 'attention'
  if (item.reviewDecision === 'APPROVED') return 'success'
  return 'open'
}

function listStateLabel(item: PullRequestListItem): string {
  if (item.isDraft && item.state === 'CLOSED') return 'Closed draft'
  if (item.isDraft) return 'Draft'
  if (item.state === 'MERGED') return 'Merged'
  if (item.state === 'CLOSED') return 'Closed'
  return 'Open'
}

function matchesPullRequestFilters(
  item: PullRequestListItem,
  filters: PullRequestFilters,
): boolean {
  if (!statusMatches(item, filters.status)) return false
  if (!reviewMatches(item, filters.review)) return false
  if (!mergeMatches(item, filters.merge)) return false
  if (filters.repository && item.repository !== filters.repository) return false
  if (filters.author && item.author.login !== filters.author) return false
  return !filters.base || item.baseRefName === filters.base
}

function reviewMatches(item: PullRequestListItem, filter: PullRequestReviewFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'required') return item.reviewDecision === 'REVIEW_REQUIRED'
  if (filter === 'approved') return item.reviewDecision === 'APPROVED'
  if (filter === 'changes-requested') return item.reviewDecision === 'CHANGES_REQUESTED'
  return item.reviewDecision === undefined
}

function mergeMatches(item: PullRequestListItem, filter: PullRequestMergeFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'ready') return item.mergeStateStatus === 'CLEAN'
  if (filter === 'conflicts') return item.mergeStateStatus === 'DIRTY'
  if (filter === 'blocked') return item.mergeStateStatus === 'BLOCKED'
  return item.mergeStateStatus === 'BEHIND'
}

function countActivePullRequestFilters(filters: PullRequestFilters): number {
  return [
    filters.status !== 'all',
    filters.review !== 'all',
    filters.merge !== 'all',
    filters.repository !== undefined,
    filters.author !== undefined,
    filters.base !== undefined,
  ].filter(Boolean).length
}

function pullRequestFilterSelectionLabel(
  category: PullRequestFilterCategory,
  filters: PullRequestFilters,
): string {
  if (category === 'status') return statusFilterLabel(filters.status)
  if (category === 'review') return reviewFilterLabel(filters.review)
  if (category === 'merge') return mergeFilterLabel(filters.merge)
  if (category === 'repository') return filters.repository ?? 'All repositories'
  if (category === 'author') return filters.author ? `@${filters.author}` : 'Anyone'
  return filters.base ?? 'All branches'
}

function pullRequestFilterCategoryIsActive(
  category: PullRequestFilterCategory,
  filters: PullRequestFilters,
): boolean {
  if (category === 'status') return filters.status !== 'all'
  if (category === 'review') return filters.review !== 'all'
  if (category === 'merge') return filters.merge !== 'all'
  if (category === 'repository') return filters.repository !== undefined
  if (category === 'author') return filters.author !== undefined
  return filters.base !== undefined
}

type PullRequestFilterOption = {
  key: string
  label: string
  count: number
  selected: boolean
  next: PullRequestFilters
}

function pullRequestFilterOptions(
  category: PullRequestFilterCategory,
  items: PullRequestListItem[],
  filters: PullRequestFilters,
): PullRequestFilterOption[] {
  if (category === 'status') {
    return (
      [
        ['all', 'All states'],
        ['open', 'Open'],
        ['draft', 'Drafts'],
        ['merged', 'Merged'],
        ['closed', 'Closed'],
      ] as const
    ).map(([value, label]) =>
      pullRequestFilterOption(items, label, value, filters.status === value, {
        ...filters,
        status: value,
      }),
    )
  }
  if (category === 'review') {
    return (
      [
        ['all', 'Any review'],
        ['required', 'Review required'],
        ['approved', 'Approved'],
        ['changes-requested', 'Changes requested'],
        ['none', 'No decision'],
      ] as const
    ).map(([value, label]) =>
      pullRequestFilterOption(items, label, value, filters.review === value, {
        ...filters,
        review: value,
      }),
    )
  }
  if (category === 'merge') {
    return (
      [
        ['all', 'Any merge status'],
        ['ready', 'Ready to merge'],
        ['conflicts', 'Conflicts'],
        ['blocked', 'Blocked'],
        ['behind', 'Behind base'],
      ] as const
    ).map(([value, label]) =>
      pullRequestFilterOption(items, label, value, filters.merge === value, {
        ...filters,
        merge: value,
      }),
    )
  }
  if (category === 'repository') {
    return pullRequestValueFilterOptions(
      items,
      filters.repository,
      { ...filters, repository: undefined },
      'repository',
      'All repositories',
      (value) => value,
      (item) => item.repository,
      (value) => ({ ...filters, repository: value }),
    )
  }
  if (category === 'author') {
    return pullRequestValueFilterOptions(
      items,
      filters.author,
      { ...filters, author: undefined },
      'author',
      'Anyone',
      (value) => `@${value}`,
      (item) => item.author.login,
      (value) => ({ ...filters, author: value }),
    )
  }
  return pullRequestValueFilterOptions(
    items,
    filters.base,
    { ...filters, base: undefined },
    'base',
    'All branches',
    (value) => value,
    (item) => item.baseRefName,
    (value) => ({ ...filters, base: value }),
  )
}

function pullRequestValueFilterOptions(
  items: PullRequestListItem[],
  selectedValue: string | undefined,
  filtersWithoutValue: PullRequestFilters,
  keyPrefix: string,
  allLabel: string,
  valueLabel: (value: string) => string,
  valueOf: (item: PullRequestListItem) => string,
  nextFilters: (value: string | undefined) => PullRequestFilters,
): PullRequestFilterOption[] {
  const counts = countPullRequestFilterValues(
    items,
    (item) => matchesPullRequestFilters(item, filtersWithoutValue),
    valueOf,
  )
  return [undefined, ...uniqueSorted(items.map(valueOf))].map((value) => ({
    key: `${keyPrefix}:${value ?? 'all'}`,
    label: value === undefined ? allLabel : valueLabel(value),
    count: value === undefined ? counts.total : (counts.byValue.get(value) ?? 0),
    selected: selectedValue === value,
    next: nextFilters(value),
  }))
}

function pullRequestFilterOption(
  items: PullRequestListItem[],
  label: string,
  key: string,
  selected: boolean,
  next: PullRequestFilters,
): PullRequestFilterOption {
  return {
    key,
    label,
    selected,
    next,
    count: items.filter((item) => matchesPullRequestFilters(item, next)).length,
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort(comparePullRequestText)
}

function statusMatches(item: PullRequestListItem, filter: PullRequestStatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'draft') return item.isDraft
  if (filter === 'open') return item.state === 'OPEN'
  if (filter === 'merged') return item.state === 'MERGED'
  return item.state === 'CLOSED'
}

function statusFilterLabel(filter: PullRequestStatusFilter): string {
  if (filter === 'all') return 'All states'
  if (filter === 'draft') return 'Drafts'
  return capitalize(filter)
}

function reviewFilterLabel(filter: PullRequestReviewFilter): string {
  if (filter === 'all') return 'Any review'
  if (filter === 'required') return 'Review required'
  if (filter === 'changes-requested') return 'Changes requested'
  if (filter === 'none') return 'No decision'
  return 'Approved'
}

function mergeFilterLabel(filter: PullRequestMergeFilter): string {
  if (filter === 'all') return 'Any merge status'
  if (filter === 'ready') return 'Ready to merge'
  if (filter === 'conflicts') return 'Conflicts'
  if (filter === 'behind') return 'Behind base'
  return 'Blocked'
}

function formatCount(value: number): string {
  return value >= 10_000
    ? `${Math.round(value / 1_000)}k`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value)
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value)
  const minutes = Math.max(0, Math.floor(elapsed / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
