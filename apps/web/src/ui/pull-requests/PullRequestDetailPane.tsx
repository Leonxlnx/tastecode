import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  PullRequestAction,
  PullRequestComment,
  PullRequestDetail,
  PullRequestListItem,
  PullRequestMetadataOptions,
  PullRequestReview,
  PullRequestReviewThread,
} from '@harness/contracts'
import {
  IconArrowUp as ArrowUp,
  IconArrowUpRight as ArrowUpRight,
  IconRobot as Bot,
  IconCheck as Check,
  IconCircleCheck as CheckCircle2,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconAlertCircle as CircleAlert,
  IconCircleDot as CircleDot,
  IconClock as Clock3,
  IconDots as Ellipsis,
  IconGitBranch as GitBranch,
  IconGitMerge as GitMerge,
  IconGitPullRequest as GitPullRequest,
  IconGitPullRequestClosed as GitPullRequestClosed,
  IconGitPullRequestDraft as GitPullRequestDraft,
  IconLoader2 as LoaderCircle,
  IconMessage as MessageSquare,
  IconPencil as Pencil,
  IconRefresh as RefreshCw,
  IconRotate as RotateCcw,
  IconSearch as Search,
  IconTag as Tag,
  IconTrash as Trash2,
  IconUser as UserRound,
  IconUsers as Users,
  IconX as X,
  IconCircleX as XCircle,
} from '@tabler/icons-react'
import type { Transport } from '../../transport.js'
import { AppSelect } from '../AppSelect.js'
import { IconMorph } from '../IconMorph.js'
import { Markdown } from '../Markdown.js'
import { Menu, MenuItem } from '../Menu.js'
import { PullRequestFiles } from './PullRequestFiles.js'
import { comparePullRequestText, countLabel } from './pull-request-text.js'
import { errorMessage as messageOf } from '../../boundary.js'

type DetailTab = 'summary' | 'files'

type Confirmation = {
  title: string
  detail: string
  confirmLabel: string
  action: PullRequestAction
  danger?: boolean
}

type DetailUpdater = (detail: PullRequestDetail) => PullRequestDetail
type MetadataUpdateContext = Pick<PullRequestMetadataOptions, 'reviewers' | 'assignees' | 'labels'>
type RunPullRequestAction = (action: PullRequestAction, update?: DetailUpdater) => Promise<boolean>
type LabelColorStyle = CSSProperties & { '--label-color': string }
type StoredMergeMethod = NonNullable<PullRequestDetail['autoMerge']>['mergeMethod']

function labelColorStyle(color: string): LabelColorStyle {
  return { '--label-color': `#${color}` }
}

export function PullRequestDetailPane(props: {
  item: PullRequestListItem
  transport: Transport
  onOpenChat: () => void
  onChanged: (detail: PullRequestDetail) => void
}) {
  const [detail, setDetail] = useState<PullRequestDetail>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string }>()
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [tab, setTab] = useState<DetailTab>('summary')
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const request = useRef(0)
  const detailRef = useRef<PullRequestDetail | undefined>(undefined)
  const pendingKeysRef = useRef(new Set<string>())
  const needsRevalidation = useRef(false)
  const revalidationTimer = useRef<number | undefined>(undefined)

  const load = useCallback(
    async (refresh = false, silent = false): Promise<PullRequestDetail | undefined> => {
      const id = ++request.current
      if (!silent) {
        if (refresh) setRefreshing(true)
        else setLoading(true)
        setError(undefined)
      }
      try {
        const next = await props.transport.request('pullRequests.detail', {
          repository: props.item.repository,
          number: props.item.number,
          refresh,
        })
        if (id === request.current) {
          detailRef.current = next
          setDetail(next)
          return next
        }
      } catch (cause) {
        if (id === request.current && !silent) setError(messageOf(cause))
      } finally {
        if (id === request.current && !silent) {
          setLoading(false)
          setRefreshing(false)
        }
      }
      return undefined
    },
    [props.item.number, props.item.repository, props.transport],
  )

  useEffect(() => {
    void load()
    return () => {
      request.current += 1
      if (revalidationTimer.current !== undefined) {
        window.clearTimeout(revalidationTimer.current)
      }
    }
  }, [load])

  const runAction = useCallback<RunPullRequestAction>(
    async (action, update) => {
      const pendingKey = actionPendingKey(action)
      if (pendingKeysRef.current.has(pendingKey)) return false
      pendingKeysRef.current.add(pendingKey)
      setPendingKeys(new Set(pendingKeysRef.current))
      setNotice(undefined)
      let succeeded = false
      try {
        const result = await props.transport.request('pullRequests.action', {
          repository: props.item.repository,
          number: props.item.number,
          action,
        })
        const current = detailRef.current
        if (current) {
          const next = (update ?? ((value) => applySuccessfulAction(value, action)))(current)
          detailRef.current = next
          setDetail(next)
          props.onChanged(next)
        }
        setNotice({ kind: 'success', text: result.message })
        succeeded = true
        return true
      } catch (cause) {
        setNotice({ kind: 'error', text: messageOf(cause) })
        return false
      } finally {
        pendingKeysRef.current.delete(pendingKey)
        setPendingKeys(new Set(pendingKeysRef.current))
        if (succeeded) needsRevalidation.current = true
        if (pendingKeysRef.current.size === 0 && needsRevalidation.current) {
          if (revalidationTimer.current !== undefined) {
            window.clearTimeout(revalidationTimer.current)
          }
          revalidationTimer.current = window.setTimeout(() => {
            revalidationTimer.current = undefined
            if (pendingKeysRef.current.size > 0 || !needsRevalidation.current) return
            needsRevalidation.current = false
            void load(false, true).then((next) => {
              if (next) props.onChanged(next)
            })
          }, 50)
        }
      }
    },
    [load, props.item.number, props.item.repository, props.onChanged, props.transport],
  )

  if (loading && !detail) return <PullRequestDetailSkeleton />

  if (error && !detail) {
    return (
      <div className="pr-detail-error">
        <span className="pr-empty-emblem">
          <CircleAlert size={20} aria-hidden />
        </span>
        <strong>Couldn't open this pull request</strong>
        <p>{error}</p>
        <button type="button" className="pr-button is-secondary" onClick={() => void load(true)}>
          Try again
        </button>
      </div>
    )
  }

  if (!detail) return null

  const canMerge = detail.state === 'OPEN' && !detail.isDraft && detail.mergeable !== 'CONFLICTING'
  const conversationBusy = hasPendingPrefix(pendingKeys, 'conversation:')

  return (
    <div className="pr-detail">
      <header className="pr-detail-toolbar">
        <div className="pr-detail-tabs" role="tablist" aria-label="Pull request detail">
          <DetailTabButton active={tab === 'summary'} onClick={() => setTab('summary')}>
            Summary
          </DetailTabButton>
          <DetailTabButton active={tab === 'files'} onClick={() => setTab('files')}>
            Files <span>{detail.changedFiles}</span>
          </DetailTabButton>
        </div>

        <div className="pr-detail-actions">
          <button
            type="button"
            className="pr-icon-button"
            aria-label="Refresh pull request"
            title="Refresh pull request"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw size={14} className={refreshing ? 'is-spinning' : undefined} aria-hidden />
          </button>
          <a
            className="pr-icon-button"
            href={detail.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open on GitHub"
            title="Open on GitHub"
          >
            <ArrowUpRight size={14} aria-hidden />
          </a>
          <button
            type="button"
            className="pr-button is-secondary pr-chat-button"
            disabled={!detail.localProjectPath}
            title={
              detail.localProjectPath
                ? 'Start a TasteCode chat in the local checkout'
                : 'Add this repository as a TasteCode project to chat about it'
            }
            onClick={props.onOpenChat}
          >
            <MessageSquare size={13} aria-hidden />
            Chat
          </button>
          <AutoMergeMenu
            detail={detail}
            busy={pendingKeys.has('auto-merge')}
            onAction={runAction}
          />
          <MergeMenu
            detail={detail}
            disabled={!canMerge || pendingKeys.has('merge')}
            onChoose={(method) =>
              setConfirmation({
                title: `Merge #${detail.number}?`,
                detail:
                  `This will ${mergeMethodLabel(method).toLowerCase()} ${detail.headRefName} into ${detail.baseRefName}.` +
                  (detail.mergeMethods.deleteBranchOnMerge
                    ? " GitHub will remove the source branch using this repository's merge setting."
                    : ''),
                confirmLabel: 'Merge pull request',
                action: {
                  type: 'merge',
                  method,
                  // GitHub applies delete_branch_on_merge itself. Passing gh's
                  // --delete-branch would additionally touch a local checkout.
                  deleteBranch: false,
                },
              })
            }
          />
          {detail.state === 'OPEN' || detail.state === 'CLOSED' ? (
            <MoreMenu
              detail={detail}
              busy={
                pendingKeys.has('status') ||
                pendingKeys.has('branch-update') ||
                pendingKeys.has('checks')
              }
              onAction={runAction}
              onConfirm={setConfirmation}
            />
          ) : null}
        </div>
      </header>

      {notice ? (
        <div className={`pr-notice is-${notice.kind}`} role="status">
          {notice.kind === 'success' ? (
            <Check size={13} aria-hidden />
          ) : (
            <CircleAlert size={13} aria-hidden />
          )}
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(undefined)}>
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      <div className={`pr-detail-body is-${tab}`}>
        {tab === 'summary' ? (
          <PullRequestSummary
            detail={detail}
            transport={props.transport}
            pendingKeys={pendingKeys}
            conversationBusy={conversationBusy}
            onAction={runAction}
            onConfirm={setConfirmation}
          />
        ) : (
          <PullRequestFiles
            key={detail.headRefOid}
            detail={detail}
            transport={props.transport}
            onAction={runAction}
            actionBusy={conversationBusy}
            onConfirmAction={(action) =>
              setConfirmation({
                title: 'Delete this review comment?',
                detail: 'This removes the inline comment from GitHub and cannot be undone.',
                confirmLabel: 'Delete comment',
                danger: true,
                action,
              })
            }
          />
        )}
      </div>

      {tab === 'summary' && detail.state === 'OPEN' ? (
        <PullRequestComposer
          detail={detail}
          busy={pendingKeys.has('composer')}
          onAction={runAction}
        />
      ) : null}

      {confirmation ? (
        <ConfirmDialog
          confirmation={confirmation}
          busy={pendingKeys.has(actionPendingKey(confirmation.action))}
          onClose={() => setConfirmation(undefined)}
          onConfirm={async () => {
            if (await runAction(confirmation.action)) setConfirmation(undefined)
          }}
        />
      ) : null}
    </div>
  )
}

function PullRequestSummary(props: {
  detail: PullRequestDetail
  transport: Transport
  pendingKeys: ReadonlySet<string>
  conversationBusy: boolean
  onAction: RunPullRequestAction
  onConfirm: (confirmation: Confirmation) => void
}) {
  const detail = props.detail
  const checks = checkSummary(detail)
  const status = pullRequestStatus(detail)
  const [descriptionOpen, setDescriptionOpen] = useState(true)
  const [titleEditing, setTitleEditing] = useState(false)
  const [descriptionEditing, setDescriptionEditing] = useState(false)
  const [editFocus, setEditFocus] = useState<'title' | 'description'>('title')
  const [metadataOptions, setMetadataOptions] = useState<PullRequestMetadataOptions>()
  const [metadataOptionsLoading, setMetadataOptionsLoading] = useState(false)
  const [metadataOptionsError, setMetadataOptionsError] = useState<string>()
  const metadataOptionsRef = useRef<PullRequestMetadataOptions | undefined>(undefined)
  const metadataRequest = useRef<Promise<void> | undefined>(undefined)
  const canManageMetadata =
    detail.relationship === 'authored' ||
    detail.relationship === 'both' ||
    detail.permissions.canPush

  const beginTitleEditing = () => {
    setEditFocus('title')
    setTitleEditing(true)
  }
  const beginDescriptionEditing = () => {
    setEditFocus('description')
    setDescriptionOpen(true)
    setDescriptionEditing(true)
  }

  const loadMetadataOptions = useCallback(
    async (refresh = false) => {
      if (!refresh && metadataOptionsRef.current) return
      if (!refresh && metadataRequest.current) return metadataRequest.current
      setMetadataOptionsLoading(true)
      setMetadataOptionsError(undefined)
      const pending = props.transport
        .request('pullRequests.metadataOptions', {
          repository: detail.repository,
          ...(refresh ? { includedValue: true } : {}),
        })
        .then((next) => {
          metadataOptionsRef.current = next
          setMetadataOptions(next)
        })
        .catch((cause) => setMetadataOptionsError(messageOf(cause)))
        .finally(() => {
          metadataRequest.current = undefined
          setMetadataOptionsLoading(false)
        })
      metadataRequest.current = pending
      return pending
    },
    [detail.repository, props.transport],
  )

  const reviewers = mergeActors(
    metadataOptions?.reviewers ?? [],
    detail.reviewers.map((reviewer) => reviewer.actor),
    detail.requestedReviewers,
  ).filter((actorValue) => actorValue.login !== detail.author.login)
  const assignees = mergeActors(metadataOptions?.assignees ?? [], detail.assignees)
  const labels = mergeLabels(metadataOptions?.labels ?? [], detail.labels)
  const milestones = mergeMilestones(metadataOptions?.milestones ?? [], detail.milestone)
  const branches = mergeStrings(metadataOptions?.baseBranches ?? [], [detail.baseRefName])
  const requestedReviewers = lowerSet(
    detail.requestedReviewers.map((actorValue) => actorValue.login),
  )
  const currentAssignees = lowerSet(detail.assignees.map((actorValue) => actorValue.login))
  const currentLabels = lowerSet(detail.labels.map((label) => label.name))
  const reviewerStates = new Map(
    detail.reviewers.map((reviewer) => [reviewer.actor.login.toLowerCase(), reviewer.state]),
  )
  const runMetadataAction = (action: Extract<PullRequestAction, { type: 'update_metadata' }>) =>
    props.onAction(action, (current) =>
      applySuccessfulAction(current, action, { reviewers, assignees, labels }),
    )
  const pickerState = (source: PullRequestMetadataOptions['unavailable'][number]) => ({
    loading: metadataOptionsLoading,
    loaded: Boolean(metadataOptions),
    error: metadataOptionsError,
    unavailable: metadataOptions?.unavailable.includes(source) ?? false,
    truncated: metadataOptions?.truncated ?? false,
    onLoad: loadMetadataOptions,
  })

  const branchValue = (
    <span className="pr-branch-value">
      <strong>{detail.headRefName}</strong>
      <ChevronRight size={13} aria-hidden />
      <strong>{detail.baseRefName}</strong>
      <span className="pr-branch-stats">
        <span className="is-addition">+{detail.additions.toLocaleString()}</span>
        <span className="is-deletion">−{detail.deletions.toLocaleString()}</span>
      </span>
    </span>
  )
  const reviewerValue =
    detail.reviewers.length > 0 ? (
      <span className="pr-actor-stack">
        {detail.reviewers.slice(0, 5).map((reviewer) => (
          <Actor key={reviewer.actor.login} actor={reviewer.actor} state={reviewer.state} compact />
        ))}
        {detail.reviewers.length > 5 ? <span>+{detail.reviewers.length - 5}</span> : null}
      </span>
    ) : (
      <span className="is-muted">No reviewers</span>
    )
  const assigneeValue =
    detail.assignees.length > 0 ? (
      <span className="pr-actor-stack">
        {detail.assignees.slice(0, 5).map((assignee) => (
          <Actor key={assignee.login} actor={assignee} compact />
        ))}
        {detail.assignees.length > 5 ? <span>+{detail.assignees.length - 5}</span> : null}
      </span>
    ) : (
      <span className="is-muted">No assignees</span>
    )

  return (
    <div className="pr-summary-scroll">
      <article className="pr-summary">
        <header className="pr-summary-head">
          <div className="pr-summary-title">
            {titleEditing ? (
              <PullRequestTitleEditor
                title={detail.title}
                busy={props.pendingKeys.has('edit')}
                autoFocus={editFocus === 'title'}
                onCancel={() => setTitleEditing(false)}
                onSave={async (title) => {
                  if (await props.onAction({ type: 'edit', title })) setTitleEditing(false)
                }}
              />
            ) : (
              <div>
                <h2>{detail.title}</h2>
                <button
                  type="button"
                  className="pr-inline-icon"
                  aria-label="Edit title"
                  disabled={props.pendingKeys.has('edit')}
                  onClick={beginTitleEditing}
                >
                  <Pencil size={13} aria-hidden />
                </button>
              </div>
            )}
            <p>
              <Actor actor={detail.author} />
              <span>·</span>
              <time dateTime={detail.createdAt}>{longRelativeTime(detail.createdAt)}</time>
            </p>
          </div>
        </header>

        <section className="pr-facts" aria-label="Pull request metadata">
          <Fact icon={<GitBranch size={15} aria-hidden />} label="Branch">
            {canManageMetadata && detail.state === 'OPEN' ? (
              <PullRequestMetadataPicker
                label="Change base branch"
                placeholder="Find a branch"
                indicator="chevron"
                options={branches.map((branch) => ({
                  key: branch,
                  label: branch,
                  selected: branch === detail.baseRefName,
                  icon: <GitBranch size={14} aria-hidden />,
                }))}
                {...pickerState('baseBranches')}
                busy={
                  props.pendingKeys.has('metadata:branch') || props.pendingKeys.has('branch-update')
                }
                closeOnSelect
                onSelect={(branch) =>
                  branch === detail.baseRefName
                    ? Promise.resolve(true)
                    : runMetadataAction(metadataAction({ baseRefName: branch }))
                }
                trigger={branchValue}
              />
            ) : (
              branchValue
            )}
          </Fact>

          <Fact icon={<Users size={15} aria-hidden />} label="Reviewers">
            {canManageMetadata && detail.state === 'OPEN' ? (
              <PullRequestMetadataPicker
                label="Request reviewers"
                placeholder="Request review from…"
                indicator="ellipsis"
                options={reviewers.map((actorValue) => {
                  const key = actorValue.login.toLowerCase()
                  const state = reviewerStates.get(key)
                  const requested = requestedReviewers.has(key)
                  return {
                    key: actorValue.login,
                    label: actorValue.login,
                    detail: requested
                      ? 'Review requested'
                      : state
                        ? reviewerPickerStateLabel(state)
                        : actorValue.isBot
                          ? 'Bot collaborator'
                          : 'Collaborator',
                    selected: requested || Boolean(state),
                    icon: <MetadataActorMark actor={actorValue} />,
                  }
                })}
                {...pickerState('reviewers')}
                busy={props.pendingKeys.has('metadata:reviewers')}
                preserveTriggerLayout
                onSelect={(login) =>
                  runMetadataAction(
                    metadataAction(
                      requestedReviewers.has(login.toLowerCase())
                        ? { removeReviewers: [login] }
                        : { addReviewers: [login] },
                    ),
                  )
                }
                trigger={reviewerValue}
              />
            ) : (
              reviewerValue
            )}
          </Fact>

          <Fact icon={<UserRound size={15} aria-hidden />} label="Assignees">
            {canManageMetadata ? (
              <PullRequestMetadataPicker
                label="Manage assignees"
                placeholder="Find an assignee"
                options={assignees.map((actorValue) => ({
                  key: actorValue.login,
                  label: actorValue.login,
                  detail: actorValue.isBot ? 'Bot' : undefined,
                  selected: currentAssignees.has(actorValue.login.toLowerCase()),
                  icon: <MetadataActorMark actor={actorValue} />,
                }))}
                {...pickerState('assignees')}
                busy={props.pendingKeys.has('metadata:assignees')}
                preserveTriggerLayout
                onSelect={(login) =>
                  runMetadataAction(
                    metadataAction(
                      currentAssignees.has(login.toLowerCase())
                        ? { removeAssignees: [login] }
                        : { addAssignees: [login] },
                    ),
                  )
                }
                trigger={assigneeValue}
              />
            ) : (
              assigneeValue
            )}
          </Fact>

          <Fact icon={<Tag size={15} aria-hidden />} label="Labels">
            {canManageMetadata ? (
              <PullRequestMetadataPicker
                label="Manage labels"
                placeholder="Find a label"
                options={labels.map((label) => ({
                  key: label.name,
                  label: label.name,
                  detail: label.description,
                  selected: currentLabels.has(label.name.toLowerCase()),
                  icon: (
                    <span className="pr-picker-label-color" style={labelColorStyle(label.color)} />
                  ),
                }))}
                {...pickerState('labels')}
                busy={props.pendingKeys.has('metadata:labels')}
                preserveTriggerLayout={detail.labels.length === 0}
                onSelect={(name) =>
                  runMetadataAction(
                    metadataAction(
                      currentLabels.has(name.toLowerCase())
                        ? { removeLabels: [name] }
                        : { addLabels: [name] },
                    ),
                  )
                }
                trigger={
                  detail.labels.length > 0 ? (
                    <span className="pr-label-stack">
                      {detail.labels.slice(0, 4).map((label) => (
                        <span
                          className="pr-label"
                          key={label.name}
                          style={labelColorStyle(label.color)}
                        >
                          {label.name}
                        </span>
                      ))}
                      {detail.labels.length > 4 ? <span>+{detail.labels.length - 4}</span> : null}
                    </span>
                  ) : (
                    <span className="is-muted">No labels</span>
                  )
                }
              />
            ) : detail.labels.length > 0 ? (
              <span className="pr-label-stack">
                {detail.labels.map((label) => (
                  <span className="pr-label" key={label.name} style={labelColorStyle(label.color)}>
                    {label.name}
                  </span>
                ))}
              </span>
            ) : (
              <span className="is-muted">No labels</span>
            )}
          </Fact>

          <Fact icon={<Clock3 size={15} aria-hidden />} label="Milestone">
            {canManageMetadata ? (
              <PullRequestMetadataPicker
                label="Manage milestone"
                placeholder="Find a milestone"
                indicator="chevron"
                options={[
                  {
                    key: '',
                    label: 'No milestone',
                    selected: !detail.milestone,
                    icon: <X size={13} aria-hidden />,
                  },
                  ...milestones.map((milestone) => ({
                    key: milestone.title,
                    label: milestone.title,
                    selected: milestone.title === detail.milestone,
                    icon: <Clock3 size={13} aria-hidden />,
                  })),
                ]}
                {...pickerState('milestones')}
                busy={props.pendingKeys.has('metadata:milestone')}
                closeOnSelect
                preserveTriggerLayout={!detail.milestone}
                onSelect={(title) =>
                  title === (detail.milestone ?? '')
                    ? Promise.resolve(true)
                    : runMetadataAction(metadataAction({ milestone: title || null }))
                }
                trigger={
                  detail.milestone ? (
                    <span className="pr-milestone">{detail.milestone}</span>
                  ) : (
                    <span className="is-muted">No milestone</span>
                  )
                }
              />
            ) : detail.milestone ? (
              <span className="pr-milestone">{detail.milestone}</span>
            ) : (
              <span className="is-muted">No milestone</span>
            )}
          </Fact>

          <Fact icon={<MessageSquare size={15} aria-hidden />} label="Comments">
            <span>{countLabel(detail.comments.length, 'comment')}</span>
            {detail.reviewThreads.some((thread) => !thread.resolved) ? (
              <span>· {detail.reviewThreads.filter((thread) => !thread.resolved).length} open</span>
            ) : null}
          </Fact>
          <Fact icon={checks.icon} label="Checks">
            <span className={`pr-status-text is-${checks.tone}`}>
              {props.pendingKeys.has('checks') ? (
                <LoaderCircle size={13} className="is-spinning" aria-hidden />
              ) : null}
              {checks.label}
            </span>
          </Fact>
          <Fact icon={status.icon} label="Status">
            <PullRequestStatusPicker
              detail={detail}
              status={status}
              disabled={!canManageMetadata}
              busy={props.pendingKeys.has('status')}
              onAction={props.onAction}
              onConfirm={props.onConfirm}
            />
          </Fact>
        </section>

        <section className="pr-description">
          <div className="pr-section-title">
            <button
              type="button"
              className="pr-description-toggle"
              aria-expanded={descriptionOpen}
              onClick={() => setDescriptionOpen((current) => !current)}
            >
              Description
              <ChevronDown size={13} aria-hidden />
            </button>
            {!descriptionEditing ? (
              <button
                type="button"
                className="pr-inline-icon"
                aria-label="Edit description"
                disabled={props.pendingKeys.has('edit')}
                onClick={beginDescriptionEditing}
              >
                <Pencil size={13} aria-hidden />
              </button>
            ) : null}
          </div>
          {descriptionOpen ? (
            descriptionEditing ? (
              <PullRequestDescriptionEditor
                body={detail.body}
                busy={props.pendingKeys.has('edit')}
                autoFocus={editFocus === 'description'}
                onCancel={() => setDescriptionEditing(false)}
                onSave={async (body) => {
                  if (await props.onAction({ type: 'edit', body })) setDescriptionEditing(false)
                }}
              />
            ) : detail.body.trim() ? (
              <div className="pr-description-preview">
                <Markdown text={detail.body} />
              </div>
            ) : (
              <button
                type="button"
                className="pr-empty-description"
                onClick={beginDescriptionEditing}
              >
                Add a description
              </button>
            )
          ) : null}
        </section>

        <PullRequestActivity
          detail={detail}
          busy={props.conversationBusy}
          onAction={props.onAction}
          onConfirm={props.onConfirm}
        />

        {detail.checks.length > 0 ? <PullRequestChecks detail={detail} /> : null}
      </article>
    </div>
  )
}

function PullRequestTitleEditor(props: {
  title: string
  busy: boolean
  autoFocus: boolean
  onCancel: () => void
  onSave: (title: string) => Promise<void>
}) {
  const [title, setTitle] = useState(props.title)
  const cancelled = useRef(false)
  const submitting = useRef(false)

  const save = () => {
    const nextTitle = title.trim()
    if (props.busy || submitting.current || cancelled.current) return
    if (!nextTitle || nextTitle === props.title) {
      props.onCancel()
      return
    }
    submitting.current = true
    void props.onSave(nextTitle).finally(() => {
      submitting.current = false
    })
  }

  return (
    <input
      className="pr-title-editor"
      aria-label="Pull request title"
      aria-busy={props.busy}
      value={title}
      readOnly={props.busy}
      autoFocus={props.autoFocus}
      onBlur={save}
      onChange={(event) => setTitle(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !props.busy) {
          event.preventDefault()
          event.currentTarget.blur()
          return
        }
        if (event.key !== 'Escape' || props.busy) return
        event.preventDefault()
        cancelled.current = true
        props.onCancel()
      }}
    />
  )
}

function PullRequestDescriptionEditor(props: {
  body: string
  busy: boolean
  autoFocus: boolean
  onCancel: () => void
  onSave: (body: string) => Promise<void>
}) {
  const [body, setBody] = useState(props.body)
  const input = useRef<HTMLTextAreaElement>(null)
  const cancelled = useRef(false)
  const submitting = useRef(false)

  useEffect(() => {
    const textarea = input.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [body])

  const save = () => {
    if (props.busy || submitting.current || cancelled.current) return
    if (body === props.body) {
      props.onCancel()
      return
    }
    submitting.current = true
    void props.onSave(body).finally(() => {
      submitting.current = false
    })
  }

  return (
    <textarea
      ref={input}
      className="pr-description-editor"
      aria-label="Pull request description"
      aria-busy={props.busy}
      value={body}
      placeholder="Add a description"
      readOnly={props.busy}
      autoFocus={props.autoFocus}
      onBlur={save}
      onChange={(event) => setBody(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !props.busy) {
          event.preventDefault()
          cancelled.current = true
          props.onCancel()
          return
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !props.busy) {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
    />
  )
}

type PullRequestPickerOption = {
  key: string
  label: string
  detail?: string | undefined
  selected: boolean
  icon: ReactNode
}

type PullRequestMetadataPickerProps = {
  label: string
  placeholder: string
  indicator?: 'chevron' | 'ellipsis' | undefined
  trigger: ReactNode
  options: PullRequestPickerOption[]
  loading: boolean
  loaded: boolean
  error: string | undefined
  unavailable: boolean
  truncated: boolean
  busy: boolean
  closeOnSelect?: boolean | undefined
  preserveTriggerLayout?: boolean | undefined
  onLoad: (refresh?: boolean) => Promise<void>
  onSelect: (key: string) => Promise<boolean>
}

function PullRequestMetadataPicker(props: PullRequestMetadataPickerProps) {
  return (
    <Menu
      align="left"
      drop="down"
      disabled={props.busy}
      label={props.label}
      triggerClassName={`pr-fact-menu-trigger${props.preserveTriggerLayout ? ' is-shape-preserving' : ''}${props.busy ? ' is-pending' : ''}`}
      panelRole="dialog"
      panelLabel={props.label}
      panelClassName="pr-metadata-menu"
      trigger={() => (
        <span className="pr-fact-menu-value">
          <span>{props.trigger}</span>
          <span className="pr-fact-menu-indicator" aria-hidden>
            <IconMorph active={props.busy ? 2 : props.indicator === 'ellipsis' ? 1 : 0}>
              <ChevronDown size={13} />
              <Ellipsis size={15} />
              <LoaderCircle size={13} className="is-spinning" />
            </IconMorph>
          </span>
        </span>
      )}
    >
      {(close) => <PullRequestMetadataPickerPanel {...props} onClose={close} />}
    </Menu>
  )
}

function PullRequestMetadataPickerPanel(
  props: Omit<PullRequestMetadataPickerProps, 'trigger'> & { onClose: () => void },
) {
  const [query, setQuery] = useState('')
  const [selectingKey, setSelectingKey] = useState<string>()
  useEffect(() => {
    void props.onLoad()
  }, [props.onLoad])

  const normalizedQuery = query.trim().toLowerCase()
  const options = props.options
    .filter((option) =>
      `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(normalizedQuery),
    )
    .sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1
      return comparePullRequestText(left.label, right.label)
    })
  const waiting = !props.loaded || props.loading

  return (
    <div className="pr-picker">
      <label className="pr-picker-search">
        <Search size={14} aria-hidden />
        <input
          value={query}
          autoFocus
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="pr-picker-options">
        {options.map((option) => (
          <button
            type="button"
            className={`pr-picker-option${option.selected ? ' is-selected' : ''}`}
            key={option.key || '__empty'}
            disabled={props.busy || selectingKey !== undefined}
            aria-busy={selectingKey === option.key}
            onClick={() => {
              setSelectingKey(option.key)
              void props
                .onSelect(option.key)
                .then((success) => {
                  if (success && props.closeOnSelect) props.onClose()
                })
                .finally(() => setSelectingKey(undefined))
            }}
          >
            <span className="pr-picker-option-icon">{option.icon}</span>
            <span className="pr-picker-option-copy">
              <strong>{option.label}</strong>
              {option.detail ? <small>{option.detail}</small> : null}
            </span>
            {selectingKey === option.key ? (
              <LoaderCircle size={14} className="is-spinning" aria-hidden />
            ) : option.selected ? (
              <Check size={14} aria-hidden />
            ) : null}
          </button>
        ))}
        {waiting ? (
          <div className="pr-picker-loading" role="status">
            <LoaderCircle size={14} className="is-spinning" aria-hidden />
            Loading from GitHub…
          </div>
        ) : null}
        {!waiting && options.length === 0 ? (
          <p className="pr-picker-empty">
            {normalizedQuery ? 'No matching options' : 'No options available'}
          </p>
        ) : null}
      </div>
      {props.error ? (
        <button type="button" className="pr-picker-retry" onClick={() => void props.onLoad(true)}>
          {props.error} · Retry
        </button>
      ) : props.unavailable ? (
        <p className="pr-picker-note">GitHub did not allow this option list to be loaded.</p>
      ) : props.truncated ? (
        <p className="pr-picker-note">Showing the first 1,000 repository options.</p>
      ) : null}
    </div>
  )
}

function PullRequestStatusPicker(props: {
  detail: PullRequestDetail
  status: ReturnType<typeof pullRequestStatus>
  disabled: boolean
  busy: boolean
  onAction: RunPullRequestAction
  onConfirm: (confirmation: Confirmation) => void
}) {
  const content = (
    <span className={`pr-status-pill is-${props.status.tone}`}>
      {props.status.label}
      {props.busy ? (
        <LoaderCircle size={12} className="is-spinning" aria-hidden />
      ) : props.detail.state !== 'MERGED' && !props.disabled ? (
        <ChevronDown size={12} aria-hidden />
      ) : null}
    </span>
  )
  if (props.detail.state === 'MERGED' || props.disabled) return content

  const choose = async (target: 'draft' | 'ready') => {
    if (props.detail.state === 'CLOSED') {
      const reopened = await props.onAction({ type: 'reopen' })
      if (!reopened) return
    }
    if (target === 'draft' && !props.detail.isDraft) {
      await props.onAction({ type: 'set_draft', draft: true })
    } else if (target === 'ready' && props.detail.isDraft) {
      await props.onAction({ type: 'set_draft', draft: false })
    }
  }

  return (
    <Menu
      align="left"
      drop="down"
      disabled={props.busy}
      label="Change pull request status"
      triggerClassName={`pr-status-menu-trigger${props.busy ? ' is-pending' : ''}`}
      panelClassName="pr-status-menu"
      trigger={() => content}
    >
      {(close) => (
        <>
          <MenuItem
            title="Draft"
            icon={<GitPullRequestDraft size={14} aria-hidden />}
            active={props.detail.state === 'OPEN' && props.detail.isDraft}
            onClick={() => {
              close()
              void choose('draft')
            }}
          />
          <MenuItem
            title="Ready for review"
            icon={<CheckCircle2 size={14} aria-hidden />}
            active={props.detail.state === 'OPEN' && !props.detail.isDraft}
            onClick={() => {
              close()
              void choose('ready')
            }}
          />
          <MenuItem
            title="Closed"
            icon={<GitPullRequestClosed size={14} aria-hidden />}
            active={props.detail.state === 'CLOSED'}
            onClick={() => {
              close()
              if (props.detail.state === 'CLOSED') return
              props.onConfirm({
                title: `Close #${props.detail.number}?`,
                detail:
                  'The pull request can be reopened later, and its branch will remain untouched.',
                confirmLabel: 'Close pull request',
                danger: true,
                action: { type: 'close' },
              })
            }}
          />
        </>
      )}
    </Menu>
  )
}

function MetadataActorMark(props: { actor: PullRequestDetail['author'] }) {
  return <GitHubAvatar actor={props.actor} className="pr-picker-avatar" botSize={12} />
}

function metadataAction(
  changes: Partial<Omit<Extract<PullRequestAction, { type: 'update_metadata' }>, 'type'>>,
): Extract<PullRequestAction, { type: 'update_metadata' }> {
  return {
    type: 'update_metadata',
    addReviewers: [],
    removeReviewers: [],
    addAssignees: [],
    removeAssignees: [],
    addLabels: [],
    removeLabels: [],
    ...changes,
  }
}

function actionPendingKey(action: PullRequestAction): string {
  switch (action.type) {
    case 'update_metadata': {
      const fields: string[] = []
      if (action.baseRefName !== undefined) fields.push('branch')
      if (action.addReviewers.length > 0 || action.removeReviewers.length > 0) {
        fields.push('reviewers')
      }
      if (action.addAssignees.length > 0 || action.removeAssignees.length > 0) {
        fields.push('assignees')
      }
      if (action.addLabels.length > 0 || action.removeLabels.length > 0) fields.push('labels')
      if (action.milestone !== undefined) fields.push('milestone')
      return `metadata:${fields.length === 1 ? fields[0] : 'all'}`
    }
    case 'comment':
    case 'review':
      return 'composer'
    case 'inline_comment':
      return `conversation:inline:${action.path}:${action.side}:${action.line}`
    case 'reply_to_review':
      return `conversation:reply:${action.commentId}`
    case 'update_comment':
    case 'delete_comment':
      return `conversation:${action.kind}:${action.commentId}`
    case 'resolve_thread':
      return `conversation:thread:${action.threadId}`
    case 'set_draft':
    case 'close':
    case 'reopen':
      return 'status'
    case 'edit':
      return 'edit'
    case 'update_branch':
      return 'branch-update'
    case 'rerun_checks':
      return 'checks'
    case 'merge':
      return 'merge'
    case 'enable_auto_merge':
    case 'disable_auto_merge':
      return 'auto-merge'
  }
}

function hasPendingPrefix(pending: ReadonlySet<string>, prefix: string): boolean {
  for (const key of pending) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

function applySuccessfulAction(
  detail: PullRequestDetail,
  action: PullRequestAction,
  metadata?: MetadataUpdateContext,
): PullRequestDetail {
  switch (action.type) {
    case 'comment':
      return { ...detail, commentsCount: detail.commentsCount + 1 }
    case 'update_comment':
      return updateCommentBody(detail, action.kind, action.commentId, action.body)
    case 'delete_comment':
      return removeComment(detail, action.kind, action.commentId)
    case 'resolve_thread':
      return {
        ...detail,
        reviewThreads: detail.reviewThreads.map((thread) =>
          thread.id === action.threadId ? { ...thread, resolved: action.resolved } : thread,
        ),
      }
    case 'edit': {
      const edited = { ...detail }
      if (action.title !== undefined) edited.title = action.title
      if (action.body !== undefined) edited.body = action.body
      return edited
    }
    case 'update_metadata':
      return applyMetadataUpdate(detail, action, metadata)
    case 'set_draft':
      return { ...detail, state: 'OPEN', isDraft: action.draft }
    case 'close':
      return { ...detail, state: 'CLOSED' }
    case 'reopen': {
      const { closedAt: _closedAt, ...open } = detail
      return { ...open, state: 'OPEN' }
    }
    case 'merge':
      return { ...detail, state: 'MERGED', isDraft: false }
    case 'enable_auto_merge':
      return {
        ...detail,
        autoMerge: { mergeMethod: storedMergeMethod(action.method) },
      }
    case 'disable_auto_merge': {
      const { autoMerge: _autoMerge, ...withoutAutoMerge } = detail
      return withoutAutoMerge
    }
    default:
      return detail
  }
}

function applyMetadataUpdate(
  detail: PullRequestDetail,
  action: Extract<PullRequestAction, { type: 'update_metadata' }>,
  metadata?: MetadataUpdateContext,
): PullRequestDetail {
  const availableActors = mergeActors(
    metadata?.reviewers ?? [],
    metadata?.assignees ?? [],
    detail.requestedReviewers,
    detail.assignees,
    detail.reviewers.map((reviewer) => reviewer.actor),
  )
  const actorByLogin = new Map(
    availableActors.map((actorValue) => [actorValue.login.toLowerCase(), actorValue]),
  )
  const actorFor = (login: string) =>
    actorByLogin.get(login.toLowerCase()) ?? {
      login,
      isBot: /(?:\[bot\]|-bot$|bot$)/i.test(login),
    }
  const addReviewers = lowerSet(action.addReviewers)
  const removeReviewers = lowerSet(action.removeReviewers)
  const requestedReviewers = detail.requestedReviewers.filter(
    (actorValue) => !removeReviewers.has(actorValue.login.toLowerCase()),
  )
  for (const login of action.addReviewers) {
    if (
      !requestedReviewers.some(
        (actorValue) => actorValue.login.toLowerCase() === login.toLowerCase(),
      )
    ) {
      requestedReviewers.push(actorFor(login))
    }
  }
  const reviewers = detail.reviewers.filter((reviewer) => {
    const key = reviewer.actor.login.toLowerCase()
    if (addReviewers.has(key)) return false
    return !(removeReviewers.has(key) && reviewer.state === 'REQUESTED')
  })
  for (const login of action.addReviewers) {
    reviewers.push({ actor: actorFor(login), state: 'REQUESTED' })
  }

  const removeAssignees = lowerSet(action.removeAssignees)
  const assignees = detail.assignees.filter(
    (actorValue) => !removeAssignees.has(actorValue.login.toLowerCase()),
  )
  for (const login of action.addAssignees) {
    if (!assignees.some((actorValue) => actorValue.login.toLowerCase() === login.toLowerCase())) {
      assignees.push(actorFor(login))
    }
  }

  const removeLabels = lowerSet(action.removeLabels)
  const labels = detail.labels.filter((label) => !removeLabels.has(label.name.toLowerCase()))
  const availableLabels = new Map(
    (metadata?.labels ?? []).map((label) => [label.name.toLowerCase(), label]),
  )
  for (const name of action.addLabels) {
    if (labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) continue
    const label = availableLabels.get(name.toLowerCase())
    if (label) labels.push({ name: label.name, color: label.color })
  }

  const next: PullRequestDetail = {
    ...detail,
    reviewers,
    requestedReviewers,
    assignees,
    labels,
  }
  if (action.baseRefName !== undefined) next.baseRefName = action.baseRefName
  if (action.milestone === undefined) return next
  if (action.milestone !== null) {
    next.milestone = action.milestone
    return next
  }
  const { milestone: _milestone, ...withoutMilestone } = next
  return withoutMilestone
}

function updateCommentBody(
  detail: PullRequestDetail,
  kind: 'issue' | 'review',
  commentId: number,
  body: string,
): PullRequestDetail {
  const update = (comment: PullRequestComment) =>
    comment.databaseId === commentId ? { ...comment, body } : comment
  return {
    ...detail,
    comments: kind === 'issue' ? detail.comments.map(update) : detail.comments,
    reviewThreads:
      kind === 'review'
        ? detail.reviewThreads.map((thread) => ({
            ...thread,
            comments: thread.comments.map(update),
          }))
        : detail.reviewThreads,
  }
}

function removeComment(
  detail: PullRequestDetail,
  kind: 'issue' | 'review',
  commentId: number,
): PullRequestDetail {
  return {
    ...detail,
    comments:
      kind === 'issue'
        ? detail.comments.filter((comment) => comment.databaseId !== commentId)
        : detail.comments,
    reviewThreads:
      kind === 'review'
        ? detail.reviewThreads.map((thread) => ({
            ...thread,
            comments: thread.comments.filter((comment) => comment.databaseId !== commentId),
          }))
        : detail.reviewThreads,
  }
}

function mergeActors(
  ...groups: Array<ReadonlyArray<PullRequestDetail['author']>>
): PullRequestDetail['author'][] {
  const actors = new Map<string, PullRequestDetail['author']>()
  for (const actorValue of groups.flat()) {
    const key = actorValue.login.toLowerCase()
    if (!actors.has(key)) actors.set(key, actorValue)
  }
  return [...actors.values()]
}

function mergeLabels(
  available: PullRequestMetadataOptions['labels'],
  current: PullRequestDetail['labels'],
): PullRequestMetadataOptions['labels'] {
  const labels = new Map<string, PullRequestMetadataOptions['labels'][number]>()
  for (const label of [...available, ...current]) {
    const key = label.name.toLowerCase()
    if (!labels.has(key)) labels.set(key, label)
  }
  return [...labels.values()]
}

function mergeMilestones(
  available: PullRequestMetadataOptions['milestones'],
  current: string | undefined,
): PullRequestMetadataOptions['milestones'] {
  if (!current || available.some((milestone) => milestone.title === current)) return available
  return [{ number: Number.MAX_SAFE_INTEGER, title: current }, ...available]
}

function mergeStrings(available: string[], current: string[]): string[] {
  const values = new Map<string, string>()
  for (const value of [...current, ...available]) {
    if (!values.has(value.toLowerCase())) values.set(value.toLowerCase(), value)
  }
  return [...values.values()]
}

function lowerSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()))
}

function reviewerPickerStateLabel(state: PullRequestDetail['reviewers'][number]['state']): string {
  if (state === 'REQUESTED') return 'Review requested'
  if (state === 'APPROVED') return 'Approved'
  if (state === 'CHANGES_REQUESTED') return 'Changes requested'
  if (state === 'DISMISSED') return 'Review dismissed'
  if (state === 'PENDING') return 'Review pending'
  return 'Review submitted'
}

function PullRequestChecks({ detail }: { detail: PullRequestDetail }) {
  return (
    <section className="pr-checks">
      <div className="pr-section-title">
        <h3>Checks</h3>
        <span>{detail.checks.length} reported</span>
      </div>
      <div className="pr-check-list">
        {detail.checks.map((check, index) => {
          const content = (
            <>
              <span className={`pr-check-state is-${check.state}`}>
                {check.state === 'success' ? (
                  <Check size={12} aria-hidden />
                ) : check.state === 'failure' || check.state === 'cancelled' ? (
                  <X size={12} aria-hidden />
                ) : check.state === 'pending' ? (
                  <LoaderCircle size={12} aria-hidden />
                ) : (
                  <CircleDot size={12} aria-hidden />
                )}
              </span>
              <span>
                <strong>{check.name}</strong>
                {check.workflowName ? <small>{check.workflowName}</small> : null}
              </span>
              <em>{checkStateLabel(check.state)}</em>
              {check.detailsUrl ? <ArrowUpRight size={12} aria-hidden /> : null}
            </>
          )
          return check.detailsUrl ? (
            <a
              key={`${check.workflowName ?? ''}:${check.name}:${index}`}
              href={check.detailsUrl}
              target="_blank"
              rel="noreferrer"
            >
              {content}
            </a>
          ) : (
            <div key={`${check.workflowName ?? ''}:${check.name}:${index}`}>{content}</div>
          )
        })}
      </div>
    </section>
  )
}

function PullRequestActivity(props: {
  detail: PullRequestDetail
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
  onConfirm: (confirmation: Confirmation) => void
}) {
  const timeline = useMemo(
    () =>
      [
        ...props.detail.comments.map((comment) => ({ type: 'comment' as const, comment })),
        ...props.detail.reviews.map((review) => ({ type: 'review' as const, review })),
      ].sort((left, right) => Date.parse(activityDate(left)) - Date.parse(activityDate(right))),
    [props.detail.comments, props.detail.reviews],
  )

  return (
    <>
      {props.detail.reviewThreads.length > 0 ? (
        <section className="pr-review-conversations">
          <div className="pr-section-title">
            <h3>Review conversations</h3>
            <span>
              {props.detail.reviewThreads.filter((thread) => !thread.resolved).length} open
            </span>
          </div>
          {props.detail.reviewThreads.map((thread) => (
            <ReviewThreadCard
              key={thread.id}
              thread={thread}
              busy={props.busy}
              onAction={props.onAction}
              onConfirm={props.onConfirm}
            />
          ))}
          {props.detail.reviewThreadsTruncated ? (
            <p className="pr-list-note">Older review conversations are available on GitHub.</p>
          ) : null}
        </section>
      ) : null}

      <section className="pr-timeline">
        <div className="pr-section-title">
          <h3>Activity</h3>
          <span>{countLabel(timeline.length, 'event')}</span>
        </div>
        {timeline.length === 0 ? (
          <p className="pr-activity-empty">No comments or reviews yet.</p>
        ) : (
          <div className="pr-timeline-list">
            {timeline.map((entry) =>
              entry.type === 'comment' ? (
                <CommentCard
                  key={`comment:${entry.comment.id}`}
                  comment={entry.comment}
                  busy={props.busy}
                  onAction={props.onAction}
                  onDelete={() =>
                    entry.comment.databaseId
                      ? props.onConfirm({
                          title: 'Delete this comment?',
                          detail: 'This removes the comment from GitHub and cannot be undone.',
                          confirmLabel: 'Delete comment',
                          danger: true,
                          action: {
                            type: 'delete_comment',
                            kind: 'issue',
                            commentId: entry.comment.databaseId,
                          },
                        })
                      : undefined
                  }
                />
              ) : (
                <ReviewCard key={`review:${entry.review.id}`} review={entry.review} />
              ),
            )}
          </div>
        )}
      </section>
    </>
  )
}

function ReviewThreadCard(props: {
  thread: PullRequestReviewThread
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
  onConfirm: (confirmation: Confirmation) => void
}) {
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const lastComment = props.thread.comments.at(-1)

  return (
    <article className={`pr-thread-card${props.thread.resolved ? ' is-resolved' : ''}`}>
      <header>
        <div>
          <code>{props.thread.path}</code>
          {props.thread.line ? <span>line {props.thread.line}</span> : null}
          {props.thread.outdated ? <span>outdated</span> : null}
        </div>
        <button
          type="button"
          className="pr-thread-state"
          disabled={props.busy}
          onClick={() =>
            void props.onAction({
              type: 'resolve_thread',
              threadId: props.thread.id,
              resolved: !props.thread.resolved,
            })
          }
        >
          <IconMorph active={props.thread.resolved ? 1 : 0}>
            <Check size={12} aria-hidden />
            <RotateCcw size={12} aria-hidden />
          </IconMorph>
          {props.thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </header>
      {props.thread.comments.map((comment) => (
        <ReviewThreadComment
          key={comment.id}
          comment={comment}
          busy={props.busy}
          onAction={props.onAction}
          onConfirm={props.onConfirm}
        />
      ))}
      {replying ? (
        <div className="pr-thread-reply">
          <textarea value={reply} onChange={(event) => setReply(event.target.value)} autoFocus />
          <div>
            <button type="button" className="pr-button is-quiet" onClick={() => setReplying(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="pr-button is-primary"
              disabled={props.busy || !reply.trim() || !lastComment?.databaseId}
              onClick={() => {
                if (!lastComment?.databaseId) return
                void props
                  .onAction({
                    type: 'reply_to_review',
                    commentId: lastComment.databaseId,
                    body: reply.trim(),
                  })
                  .then((success) => {
                    if (success) {
                      setReply('')
                      setReplying(false)
                    }
                  })
              }}
            >
              Reply
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="pr-thread-reply-link" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
    </article>
  )
}

function ReviewThreadComment(props: {
  comment: PullRequestComment
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
  onConfirm: (confirmation: Confirmation) => void
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(props.comment.body)

  return (
    <div className="pr-thread-comment">
      <header>
        <div className="pr-comment-byline">
          <Actor actor={props.comment.author} />
          <time dateTime={props.comment.createdAt}>
            {longRelativeTime(props.comment.createdAt)}
          </time>
        </div>
        {props.comment.viewerDidAuthor && props.comment.databaseId ? (
          <Menu
            align="right"
            drop="down"
            label="Review comment actions"
            trigger={() => <Ellipsis size={13} aria-hidden />}
          >
            {(close) => (
              <>
                <MenuItem
                  title="Edit comment"
                  icon={<Pencil size={13} aria-hidden />}
                  onClick={() => {
                    setEditing(true)
                    close()
                  }}
                />
                <MenuItem
                  title="Delete comment"
                  icon={<Trash2 size={13} aria-hidden />}
                  className="is-danger"
                  onClick={() => {
                    props.onConfirm({
                      title: 'Delete this review comment?',
                      detail: 'This removes the inline comment from GitHub and cannot be undone.',
                      confirmLabel: 'Delete comment',
                      danger: true,
                      action: {
                        type: 'delete_comment',
                        kind: 'review',
                        commentId: props.comment.databaseId!,
                      },
                    })
                    close()
                  }}
                />
              </>
            )}
          </Menu>
        ) : null}
      </header>
      {editing ? (
        <div className="pr-comment-editor">
          <textarea value={body} onChange={(event) => setBody(event.target.value)} autoFocus />
          <div>
            <button
              type="button"
              className="pr-button is-quiet"
              onClick={() => {
                setBody(props.comment.body)
                setEditing(false)
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pr-button is-primary"
              disabled={props.busy || !body.trim()}
              onClick={() => {
                if (!props.comment.databaseId) return
                void props
                  .onAction({
                    type: 'update_comment',
                    kind: 'review',
                    commentId: props.comment.databaseId,
                    body: body.trim(),
                  })
                  .then((success) => success && setEditing(false))
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <Markdown text={props.comment.body} />
      )}
    </div>
  )
}

function CommentCard(props: {
  comment: PullRequestComment
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(props.comment.body)

  return (
    <article className="pr-activity-card">
      <GitHubAvatar
        actor={props.comment.author}
        className="pr-avatar pr-activity-avatar"
        botSize={15}
      />
      <div className="pr-activity-comment">
        <header>
          <div className="pr-comment-byline">
            <strong>{props.comment.author.login}</strong>
            <span>commented</span>
            <a
              className="pr-comment-permalink"
              href={props.comment.url}
              target="_blank"
              rel="noreferrer"
            >
              <time dateTime={props.comment.createdAt}>
                {longRelativeTime(props.comment.createdAt)}
              </time>
            </a>
          </div>
          {props.comment.viewerDidAuthor && props.comment.databaseId ? (
            <Menu
              align="right"
              drop="down"
              label="Comment actions"
              trigger={() => <Ellipsis size={14} aria-hidden />}
            >
              {(close) => (
                <>
                  <MenuItem
                    title="Edit comment"
                    icon={<Pencil size={13} aria-hidden />}
                    onClick={() => {
                      setEditing(true)
                      close()
                    }}
                  />
                  <MenuItem
                    title="Delete comment"
                    icon={<Trash2 size={13} aria-hidden />}
                    className="is-danger"
                    onClick={() => {
                      props.onDelete()
                      close()
                    }}
                  />
                </>
              )}
            </Menu>
          ) : null}
        </header>
        {editing ? (
          <div className="pr-comment-editor">
            <textarea value={body} onChange={(event) => setBody(event.target.value)} autoFocus />
            <div>
              <button
                type="button"
                className="pr-button is-quiet"
                onClick={() => {
                  setBody(props.comment.body)
                  setEditing(false)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pr-button is-primary"
                disabled={props.busy || !body.trim()}
                onClick={() => {
                  if (!props.comment.databaseId) return
                  void props
                    .onAction({
                      type: 'update_comment',
                      kind: 'issue',
                      commentId: props.comment.databaseId,
                      body: body.trim(),
                    })
                    .then((success) => success && setEditing(false))
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="pr-activity-comment-body">
            <Markdown text={props.comment.body} />
          </div>
        )}
      </div>
    </article>
  )
}

function ReviewCard({ review }: { review: PullRequestReview }) {
  const label = reviewStateLabel(review.state)
  return (
    <article className="pr-review-event">
      <span className={`pr-review-event-icon is-${reviewTone(review.state)}`}>
        {review.state === 'APPROVED' ? (
          <Check size={13} aria-hidden />
        ) : review.state === 'CHANGES_REQUESTED' ? (
          <X size={13} aria-hidden />
        ) : (
          <MessageSquare size={13} aria-hidden />
        )}
      </span>
      <div className="pr-review-event-copy">
        <p>
          <strong>{review.author.login}</strong> <span>{label}</span>{' '}
          <time dateTime={review.submittedAt}>{longRelativeTime(review.submittedAt)}</time>
        </p>
        {review.body.trim() ? (
          <div className="pr-review-event-body">
            <Markdown text={review.body} />
          </div>
        ) : null}
      </div>
    </article>
  )
}

function PullRequestComposer(props: {
  detail: PullRequestDetail
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
}) {
  const [body, setBody] = useState('')
  const [mode, setMode] = useState<'comment' | 'approve' | 'request_changes'>('comment')
  const input = useRef<HTMLTextAreaElement>(null)
  const canReview = props.detail.relationship === 'reviewing'
  const needsBody = mode === 'comment' || mode === 'request_changes'

  useEffect(() => {
    const textarea = input.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
  }, [body])

  const submit = async () => {
    const text = body.trim()
    const action: PullRequestAction =
      mode === 'comment'
        ? { type: 'comment', body: text }
        : {
            type: 'review',
            verdict: mode,
            body: text,
          }
    if (await props.onAction(action)) setBody('')
  }

  return (
    <div className="pr-composer">
      <textarea
        ref={input}
        rows={1}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={
          mode === 'comment'
            ? 'Leave a comment'
            : mode === 'approve'
              ? 'Optional review note'
              : 'Explain what needs to change'
        }
        aria-label="Pull request comment"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            if (!props.busy && (!needsBody || body.trim())) void submit()
          }
        }}
      />
      <div className="pr-composer-foot">
        {canReview ? (
          <AppSelect
            className="pr-composer-mode"
            ariaLabel="Submission type"
            value={mode}
            onChange={setMode}
            drop="up"
            options={[
              { value: 'comment', label: 'Comment' },
              { value: 'approve', label: 'Approve' },
              { value: 'request_changes', label: 'Request changes' },
            ]}
          />
        ) : null}
        <button
          type="button"
          className={`pr-send-button is-${mode}`}
          aria-label={
            mode === 'comment'
              ? 'Send comment'
              : reviewStateLabel(mode === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED')
          }
          disabled={props.busy || (needsBody && !body.trim())}
          onClick={() => void submit()}
        >
          <IconMorph
            active={props.busy ? 3 : mode === 'approve' ? 1 : mode === 'request_changes' ? 2 : 0}
          >
            <ArrowUp size={14} aria-hidden />
            <Check size={14} aria-hidden />
            <X size={14} aria-hidden />
            <LoaderCircle size={14} className="is-spinning" aria-hidden />
          </IconMorph>
        </button>
      </div>
    </div>
  )
}

function AutoMergeMenu(props: {
  detail: PullRequestDetail
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
}) {
  return (
    <Menu
      align="right"
      drop="down"
      disabled={props.busy || props.detail.state !== 'OPEN'}
      label="Auto-merge options"
      triggerClassName={`pr-toolbar-menu-trigger${props.busy ? ' is-pending' : ''}`}
      trigger={() => (
        <span className={`pr-toolbar-button${props.detail.autoMerge ? ' is-enabled' : ''}`}>
          Auto-merge{' '}
          <IconMorph active={props.busy ? 1 : 0}>
            <ChevronDown size={12} aria-hidden />
            <LoaderCircle size={12} className="is-spinning" aria-hidden />
          </IconMorph>
        </span>
      )}
    >
      {(close) => (
        <>
          {props.detail.autoMerge ? (
            <MenuItem
              title="Disable auto-merge"
              detail={`${mergeMethodLabel(editableMergeMethod(props.detail.autoMerge.mergeMethod))} is currently queued`}
              icon={<XCircle size={13} aria-hidden />}
              onClick={() => {
                close()
                void props.onAction({ type: 'disable_auto_merge' })
              }}
            />
          ) : (
            mergeMethods(props.detail).map((method) => (
              <MenuItem
                key={method}
                title={`Enable with ${mergeMethodLabel(method)}`}
                icon={<Clock3 size={13} aria-hidden />}
                onClick={() => {
                  close()
                  void props.onAction({ type: 'enable_auto_merge', method })
                }}
              />
            ))
          )}
        </>
      )}
    </Menu>
  )
}

type MergeMethod = 'merge' | 'rebase' | 'squash'

function MergeMenu(props: {
  detail: PullRequestDetail
  disabled: boolean
  onChoose: (method: MergeMethod) => void
}) {
  return (
    <Menu
      align="right"
      drop="down"
      disabled={props.disabled}
      label="Merge pull request"
      triggerClassName="pr-toolbar-menu-trigger"
      trigger={() => (
        <span className="pr-toolbar-button is-primary">
          Merge <ChevronDown size={12} aria-hidden />
        </span>
      )}
    >
      {(close) => (
        <>
          {mergeMethods(props.detail).map((method) => (
            <MenuItem
              key={method}
              title={mergeMethodLabel(method)}
              icon={<GitMerge size={13} aria-hidden />}
              onClick={() => {
                close()
                props.onChoose(method)
              }}
            />
          ))}
          {props.detail.mergeable === 'CONFLICTING' ? (
            <p className="pr-menu-note">Resolve conflicts before merging.</p>
          ) : null}
        </>
      )}
    </Menu>
  )
}

function MoreMenu(props: {
  detail: PullRequestDetail
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
  onConfirm: (confirmation: Confirmation) => void
}) {
  return (
    <Menu
      align="right"
      drop="down"
      disabled={props.busy}
      label="More pull request actions"
      trigger={() => <Ellipsis size={15} aria-hidden />}
    >
      {(close) => (
        <>
          {props.detail.state === 'OPEN' ? (
            <>
              <MenuItem
                title={props.detail.isDraft ? 'Mark ready for review' : 'Convert to draft'}
                icon={
                  props.detail.isDraft ? (
                    <GitPullRequest size={13} aria-hidden />
                  ) : (
                    <GitPullRequestDraft size={13} aria-hidden />
                  )
                }
                onClick={() => {
                  close()
                  void props.onAction({ type: 'set_draft', draft: !props.detail.isDraft })
                }}
              />
              <MenuItem
                title="Update branch with merge"
                icon={<GitBranch size={13} aria-hidden />}
                onClick={() => {
                  close()
                  void props.onAction({ type: 'update_branch', rebase: false })
                }}
              />
              <MenuItem
                title="Update branch with rebase"
                icon={<RefreshCw size={13} aria-hidden />}
                onClick={() => {
                  close()
                  void props.onAction({ type: 'update_branch', rebase: true })
                }}
              />
              {props.detail.checks.length > 0 ? (
                <>
                  <MenuItem
                    title="Rerun failed checks"
                    icon={<RotateCcw size={13} aria-hidden />}
                    onClick={() => {
                      close()
                      void props.onAction({ type: 'rerun_checks', failedOnly: true })
                    }}
                  />
                  <MenuItem
                    title="Rerun all checks"
                    icon={<RefreshCw size={13} aria-hidden />}
                    onClick={() => {
                      close()
                      void props.onAction({ type: 'rerun_checks', failedOnly: false })
                    }}
                  />
                </>
              ) : null}
              <MenuItem
                title="Close pull request"
                icon={<GitPullRequestClosed size={13} aria-hidden />}
                className="is-danger"
                onClick={() => {
                  close()
                  props.onConfirm({
                    title: `Close #${props.detail.number}?`,
                    detail:
                      'The pull request can be reopened later, and its branch will remain untouched.',
                    confirmLabel: 'Close pull request',
                    danger: true,
                    action: { type: 'close' },
                  })
                }}
              />
            </>
          ) : props.detail.state === 'CLOSED' ? (
            <MenuItem
              title="Reopen pull request"
              icon={<RotateCcw size={13} aria-hidden />}
              onClick={() => {
                close()
                void props.onAction({ type: 'reopen' })
              }}
            />
          ) : null}
        </>
      )}
    </Menu>
  )
}

function ConfirmDialog(props: {
  confirmation: Confirmation
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog title={props.confirmation.title} onClose={props.onClose} compact>
      <p className="pr-confirm-copy">{props.confirmation.detail}</p>
      <DialogActions onCancel={props.onClose}>
        <button
          type="button"
          className={`pr-button ${props.confirmation.danger ? 'is-danger' : 'is-primary'}`}
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          {props.busy ? <LoaderCircle size={13} className="is-spinning" aria-hidden /> : null}
          {props.confirmation.confirmLabel}
        </button>
      </DialogActions>
    </Dialog>
  )
}

function Dialog(props: {
  title: string
  children: ReactNode
  onClose: () => void
  compact?: boolean
}) {
  const onClose = useRef(props.onClose)
  const panel = useRef<HTMLElement>(null)
  onClose.current = props.onClose
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose.current()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => !element.hasAttribute('disabled') && element.tabIndex !== -1,
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        panel.current.focus()
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel.current)
      ) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previousFocus?.focus()
    }
  }, [])

  return createPortal(
    <div
      className="pr-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <section
        ref={panel}
        className={`pr-dialog${props.compact ? ' is-compact' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-dialog-title"
        tabIndex={-1}
      >
        <header>
          <h2 id="pr-dialog-title">{props.title}</h2>
          <button
            type="button"
            className="pr-icon-button"
            aria-label="Close"
            onClick={props.onClose}
          >
            <X size={14} aria-hidden />
          </button>
        </header>
        <div className="pr-dialog-body">{props.children}</div>
      </section>
    </div>,
    document.body,
  )
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

function DialogActions(props: { children: ReactNode; onCancel: () => void }) {
  return (
    <div className="pr-dialog-actions">
      <button type="button" className="pr-button is-secondary" onClick={props.onCancel}>
        Cancel
      </button>
      {props.children}
    </div>
  )
}

function DetailTabButton(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      className={props.active ? 'is-active' : undefined}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function Fact(props: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="pr-fact">
      <span className="pr-fact-label">
        {props.icon}
        <span>{props.label}</span>
      </span>
      <div className="pr-fact-content">{props.children}</div>
    </div>
  )
}

function Actor(props: { actor: PullRequestDetail['author']; state?: string; compact?: boolean }) {
  return (
    <span className={`pr-actor${props.compact ? ' is-compact' : ''}`} title={props.actor.login}>
      <GitHubAvatar actor={props.actor} className="pr-avatar" botSize={11} />
      {!props.compact ? <strong>{props.actor.login}</strong> : null}
      {props.state ? <span className={`pr-review-dot is-${reviewTone(props.state)}`} /> : null}
    </span>
  )
}

function GitHubAvatar(props: {
  actor: PullRequestDetail['author']
  className: string
  botSize: number
}) {
  return (
    <span className={props.className}>
      <span className="pr-avatar-fallback" aria-hidden>
        {props.actor.isBot ? (
          <Bot size={props.botSize} />
        ) : (
          props.actor.login.slice(0, 1).toUpperCase()
        )}
      </span>
      <img
        src={`https://avatars.githubusercontent.com/${encodeURIComponent(props.actor.login)}?s=64`}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={(event) => {
          event.currentTarget.hidden = true
        }}
      />
    </span>
  )
}

function PullRequestDetailSkeleton() {
  return (
    <div className="pr-detail-skeleton" aria-label="Loading pull request">
      <div className="pr-detail-skeleton-bar" />
      <div className="pr-detail-skeleton-copy">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}

type PullRequestPresentation = {
  label: string
  tone: string
  icon: ReactNode
}

function pullRequestStatus(detail: PullRequestDetail): PullRequestPresentation {
  if (detail.state === 'MERGED')
    return { label: 'Merged', tone: 'merged', icon: <GitMerge size={15} aria-hidden /> }
  if (detail.state === 'CLOSED')
    return { label: 'Closed', tone: 'closed', icon: <GitPullRequestClosed size={15} aria-hidden /> }
  if (detail.isDraft)
    return { label: 'Draft', tone: 'draft', icon: <GitPullRequestDraft size={15} aria-hidden /> }
  if (detail.mergeable === 'CONFLICTING')
    return {
      label: 'Conflicts need resolving',
      tone: 'failure',
      icon: <CircleAlert size={15} aria-hidden />,
    }
  if (detail.reviewDecision === 'CHANGES_REQUESTED')
    return { label: 'Changes requested', tone: 'failure', icon: <XCircle size={15} aria-hidden /> }
  if (detail.reviewDecision === 'APPROVED')
    return {
      label: 'Approved and ready',
      tone: 'success',
      icon: <CheckCircle2 size={15} aria-hidden />,
    }
  if (detail.reviewDecision === 'REVIEW_REQUIRED')
    return { label: 'Review required', tone: 'attention', icon: <Users size={15} aria-hidden /> }
  return { label: 'Ready for review', tone: 'open', icon: <GitPullRequest size={15} aria-hidden /> }
}

function checkSummary(detail: PullRequestDetail): PullRequestPresentation {
  if (detail.checks.length === 0)
    return { label: 'No checks reported', tone: 'muted', icon: <CircleDot size={15} aria-hidden /> }
  const failed = detail.checks.filter(
    (check) => check.state === 'failure' || check.state === 'cancelled',
  ).length
  if (failed > 0)
    return { label: `${failed} failing`, tone: 'failure', icon: <XCircle size={15} aria-hidden /> }
  const pending = detail.checks.filter((check) => check.state === 'pending').length
  if (pending > 0)
    return {
      label: `${pending} pending`,
      tone: 'attention',
      icon: <LoaderCircle size={15} aria-hidden />,
    }
  return {
    label: `${detail.checks.length} successful`,
    tone: 'success',
    icon: <CheckCircle2 size={15} aria-hidden />,
  }
}

function checkStateLabel(state: PullRequestDetail['checks'][number]['state']): string {
  if (state === 'success') return 'Successful'
  if (state === 'failure') return 'Failed'
  if (state === 'pending') return 'In progress'
  if (state === 'cancelled') return 'Cancelled'
  if (state === 'skipped') return 'Skipped'
  return 'Neutral'
}

function mergeMethods(detail: PullRequestDetail): MergeMethod[] {
  return (['merge', 'rebase', 'squash'] as const).filter((method) => detail.mergeMethods[method])
}

function mergeMethodLabel(method: MergeMethod): string {
  if (method === 'rebase') return 'Rebase and merge'
  if (method === 'squash') return 'Squash and merge'
  return 'Create a merge commit'
}

function reviewStateLabel(state: PullRequestReviewStateLike): string {
  if (state === 'APPROVED') return 'approved these changes'
  if (state === 'CHANGES_REQUESTED') return 'requested changes'
  if (state === 'DISMISSED') return 'had a review dismissed'
  if (state === 'PENDING') return 'has a pending review'
  return 'reviewed these changes'
}

type PullRequestReviewStateLike = PullRequestReview['state'] | 'APPROVED' | 'CHANGES_REQUESTED'

function reviewTone(state: string): string {
  if (state === 'APPROVED') return 'success'
  if (state === 'CHANGES_REQUESTED') return 'failure'
  if (state === 'REQUESTED' || state === 'PENDING') return 'attention'
  return 'neutral'
}

function activityDate(
  entry:
    | { type: 'comment'; comment: PullRequestComment }
    | { type: 'review'; review: PullRequestReview },
): string {
  return entry.type === 'comment' ? entry.comment.createdAt : entry.review.submittedAt
}

function longRelativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function storedMergeMethod(method: MergeMethod): StoredMergeMethod {
  if (method === 'merge') return 'MERGE'
  if (method === 'rebase') return 'REBASE'
  return 'SQUASH'
}

function editableMergeMethod(method: StoredMergeMethod): MergeMethod {
  if (method === 'MERGE') return 'merge'
  if (method === 'REBASE') return 'rebase'
  return 'squash'
}
