import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  JsonValue,
  PullRequestAccount,
  PullRequestAction,
  PullRequestActionResult,
  PullRequestComment,
  PullRequestDetail,
  PullRequestFile,
  PullRequestFilesResult,
  PullRequestListItem,
  PullRequestListResult,
  PullRequestMetadataOptions,
  PullRequestReview,
  PullRequestReviewState,
  PullRequestReviewThread,
  PullRequestReviewer,
} from '@harness/contracts'
import { isInstalled, killTree, spawnCli } from '@harness/proc'
import { z } from 'zod'

const runFile = promisify(execFile)
const LIST_TTL_MS = 30_000
const DETAIL_TTL_MS = 15_000
const FILES_TTL_MS = 60_000
const ACCOUNT_TTL_MS = 60_000
const PROJECTS_TTL_MS = 60_000
const REPOSITORY_TTL_MS = 5 * 60_000
const REVIEW_THREADS_TTL_MS = 30_000
const METADATA_OPTIONS_TTL_MS = 5 * 60_000
const SEARCH_LIMIT = 1_000
const METADATA_OPTIONS_LIMIT = 1_000
const FILES_PAGE_SIZE = 30
const REVIEW_THREAD_LIMIT = 500
const DEFAULT_OUTPUT_LIMIT = 32 * 1024 * 1024
const DETAIL_CACHE_LIMIT = 16
const FILES_CACHE_LIMIT = 12
const METADATA_OPTIONS_CACHE_LIMIT = 8
const REPOSITORY_CACHE_LIMIT = 64
const REVIEW_THREADS_CACHE_LIMIT = 16

type GhRunOptions = {
  stdin?: string
  timeoutMs?: number
  maxBytes?: number
}

export type GhRunner = (args: string[], options?: GhRunOptions) => Promise<string>

type Cache<T> = {
  expiresAt: number
  value: T
}

function readCache<T>(cache: Map<string, Cache<T>>, key: string, now: number): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= now) {
    cache.delete(key)
    return undefined
  }
  // Map insertion order is the LRU order. A hit becomes the newest entry.
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function writeCache<T>(
  cache: Map<string, Cache<T>>,
  key: string,
  entry: Cache<T>,
  limit: number,
  now: number,
): void {
  cache.delete(key)
  cache.set(key, entry)
  for (const [cachedKey, cached] of cache) {
    if (cached.expiresAt <= now) cache.delete(cachedKey)
  }
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

type MetadataSource<T> = {
  items: T[]
  truncated: boolean
  unavailable: boolean
}

type ReviewThreadsResult = {
  threads: ParsedRawReviewThread[]
  truncated: boolean
}

type ApiMutation = {
  method: 'POST' | 'PATCH' | 'DELETE'
  endpoint: string
  input?: Record<string, JsonValue>
}

type UpdateMetadataAction = Extract<PullRequestAction, { type: 'update_metadata' }>

type PullRequestSearch = 'authored' | 'review-requested' | 'reviewed'

const RawActorSchema = z.object({
  login: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  is_bot: z.boolean().optional(),
  type: z.string().optional(),
})
const RawMetadataLabelSchema = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
  description: z.string().nullable().optional(),
})
const RawMetadataMilestoneSchema = z.object({
  number: z.number().optional(),
  title: z.string().optional(),
})
const RawMetadataBranchSchema = z.object({ name: z.string().optional() })
const RawCheckSchema = z.object({
  __typename: z.enum(['CheckRun', 'StatusContext']).optional(),
  name: z.string().optional(),
  context: z.string().optional(),
  workflowName: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  state: z.string().optional(),
  detailsUrl: z.string().optional(),
  targetUrl: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
})
const RawCommentSchema = z.object({
  id: z.string().optional(),
  databaseId: z.number().nullable().optional(),
  author: RawActorSchema.nullable().optional(),
  body: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().nullable().optional(),
  url: z.string().optional(),
})
const RawReviewSchema = z.object({
  id: z.string().optional(),
  author: RawActorSchema.nullable().optional(),
  body: z.string().optional(),
  state: z.string().optional(),
  submittedAt: z.string().optional(),
})
const RawSearchNodeSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  additions: z.number(),
  deletions: z.number(),
  comments: z.object({ totalCount: z.number().optional() }).optional(),
  author: RawActorSchema.nullable().optional(),
  repository: z.object({ nameWithOwner: z.string().optional() }).optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  reviewDecision: z.string().nullable().optional(),
  mergeStateStatus: z.string().nullable().optional(),
})
const RawSearchCliItemSchema = z.object({
  id: z.string().optional(),
  number: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  isDraft: z.boolean().optional(),
  updatedAt: z.string().optional(),
  commentsCount: z.number().optional(),
  author: RawActorSchema.nullable().optional(),
  repository: z.object({ nameWithOwner: z.string().optional() }).optional(),
})
const RawSearchPageSchema = z.object({
  data: z
    .object({
      search: z
        .object({
          nodes: z.array(RawSearchNodeSchema.nullable()).optional(),
          pageInfo: z
            .object({
              hasNextPage: z.boolean().optional(),
              endCursor: z.string().nullable().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
})
const RawPullRequestSchema = RawSearchNodeSchema.omit({ comments: true }).extend({
  body: z.string().optional(),
  createdAt: z.string().optional(),
  closedAt: z.string().nullable().optional(),
  mergedAt: z.string().nullable().optional(),
  headRefOid: z.string().optional(),
  baseRefOid: z.string().optional(),
  changedFiles: z.number().optional(),
  mergeable: z.string().optional(),
  maintainerCanModify: z.boolean().optional(),
  autoMergeRequest: z
    .object({
      mergeMethod: z.string().optional(),
      enabledAt: z.string().nullable().optional(),
      enabledBy: RawActorSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
  reviewRequests: z.array(RawActorSchema).optional(),
  assignees: z.array(RawActorSchema).optional(),
  labels: z
    .array(z.object({ name: z.string().optional(), color: z.string().optional() }))
    .optional(),
  milestone: z.object({ title: z.string().optional() }).nullable().optional(),
  statusCheckRollup: z.array(RawCheckSchema).optional(),
  comments: z.array(RawCommentSchema).optional(),
  reviews: z.array(RawReviewSchema).optional(),
})
const RawReviewThreadSchema = z.object({
  id: z.string().optional(),
  isResolved: z.boolean().optional(),
  isOutdated: z.boolean().optional(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  startLine: z.number().nullable().optional(),
  originalLine: z.number().nullable().optional(),
  originalStartLine: z.number().nullable().optional(),
  diffSide: z.string().nullable().optional(),
  startDiffSide: z.string().nullable().optional(),
  comments: z.object({ nodes: z.array(RawCommentSchema).optional() }).optional(),
})
const RawRepositorySchema = z.object({
  allow_merge_commit: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  delete_branch_on_merge: z.boolean().optional(),
  permissions: z
    .object({
      admin: z.boolean().optional(),
      push: z.boolean().optional(),
      maintain: z.boolean().optional(),
    })
    .optional(),
})
const ReviewThreadPageSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              reviewThreads: z
                .object({
                  nodes: z.array(RawReviewThreadSchema.nullable()).optional(),
                  pageInfo: z
                    .object({
                      hasNextPage: z.boolean().optional(),
                      endCursor: z.string().nullable().optional(),
                    })
                    .optional(),
                })
                .optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
})
const RawFileSchema = z.object({
  sha: z.string().optional(),
  filename: z.string().optional(),
  previous_filename: z.string().optional(),
  status: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changes: z.number().optional(),
  patch: z.string().optional(),
  blob_url: z.string().optional(),
})
const AccountSchema = z.object({ login: z.string().optional() })
const CheckRunSchema = z.object({
  bucket: z.string().optional(),
  link: z.string().optional(),
})

type ParsedRawActor = z.infer<typeof RawActorSchema>
type ParsedRawMetadataLabel = z.infer<typeof RawMetadataLabelSchema>
type ParsedRawMetadataMilestone = z.infer<typeof RawMetadataMilestoneSchema>
type ParsedRawSearchNode = z.infer<typeof RawSearchNodeSchema>
type ParsedRawSearchCliItem = z.infer<typeof RawSearchCliItemSchema>
type ParsedRawPullRequest = z.infer<typeof RawPullRequestSchema>
type ParsedRawCheck = z.infer<typeof RawCheckSchema>
type ParsedRawComment = z.infer<typeof RawCommentSchema>
type ParsedRawReview = z.infer<typeof RawReviewSchema>
type ParsedRawReviewThread = z.infer<typeof RawReviewThreadSchema>
type ParsedRawRepository = z.infer<typeof RawRepositorySchema>

const SEARCH_QUERY =
  'query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:100,after:$cursor){nodes{... on PullRequest{id number title url state isDraft updatedAt additions deletions comments{totalCount} author{login} repository{nameWithOwner} headRefName baseRefName reviewDecision mergeStateStatus}}pageInfo{hasNextPage endCursor}}}'

const REVIEW_THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line startLine originalLine originalStartLine diffSide startDiffSide comments(first:100){nodes{id databaseId body createdAt updatedAt url author{login}}}}pageInfo{hasNextPage endCursor}}}}}'

const PULL_REQUEST_FIELDS = [
  'additions',
  'assignees',
  'author',
  'autoMergeRequest',
  'baseRefName',
  'baseRefOid',
  'body',
  'changedFiles',
  'closedAt',
  'comments',
  'createdAt',
  'deletions',
  'headRefName',
  'headRefOid',
  'id',
  'isDraft',
  'labels',
  'maintainerCanModify',
  'mergeStateStatus',
  'mergeable',
  'mergedAt',
  'milestone',
  'number',
  'reviewDecision',
  'reviewRequests',
  'reviews',
  'state',
  'statusCheckRollup',
  'title',
  'updatedAt',
  'url',
].join(',')

const PULL_REQUEST_SEARCH_FIELDS = [
  'author',
  'commentsCount',
  'id',
  'isDraft',
  'number',
  'repository',
  'state',
  'title',
  'updatedAt',
  'url',
].join(',')

/**
 * GitHub-backed pull-request operations. The authenticated `gh` process owns
 * the token; neither its token nor GitHub response headers cross into the UI.
 */
export class PullRequestService {
  readonly #run: GhRunner
  readonly #installed: () => Promise<boolean>
  readonly #now: () => number
  readonly #resolveProjects: (paths: readonly string[]) => Promise<Map<string, string>>

  #accountCache: Cache<PullRequestAccount> | undefined
  #listCache: (Cache<PullRequestListResult> & { projectKey: string }) | undefined
  #detailCache = new Map<string, Cache<PullRequestDetail>>()
  #filesCache = new Map<string, Cache<PullRequestFilesResult>>()
  #metadataOptionsCache = new Map<string, Cache<PullRequestMetadataOptions>>()
  #repositoryCache = new Map<string, Cache<ParsedRawRepository>>()
  #reviewThreadsCache = new Map<string, Cache<ReviewThreadsResult>>()
  #projectCache: (Cache<Map<string, string>> & { projectKey: string }) | undefined
  #listInFlight: { projectKey: string; promise: Promise<PullRequestListResult> } | undefined
  #detailInFlight = new Map<string, Promise<PullRequestDetail>>()
  #filesInFlight = new Map<string, Promise<PullRequestFilesResult>>()
  #metadataOptionsInFlight = new Map<string, Promise<PullRequestMetadataOptions>>()
  #repositoryInFlight = new Map<string, Promise<ParsedRawRepository>>()
  #reviewThreadsInFlight = new Map<string, Promise<ReviewThreadsResult>>()

  constructor(
    options: {
      run?: GhRunner
      installed?: () => Promise<boolean>
      now?: () => number
      resolveProjects?: (paths: readonly string[]) => Promise<Map<string, string>>
    } = {},
  ) {
    this.#run = options.run ?? runGh
    this.#installed = options.installed ?? (() => isInstalled('gh'))
    this.#now = options.now ?? Date.now
    this.#resolveProjects = options.resolveProjects ?? resolveProjectRepositories
  }

  async list(projectPaths: readonly string[], refresh = false): Promise<PullRequestListResult> {
    const projectKey = sortedProjectKey(projectPaths)
    // Keep the last complete result available while the renderer refreshes it
    // in the background. Replacing 100+ useful rows with a multi-second
    // skeleton every 30 seconds makes navigation feel like a cold start.
    if (!refresh && this.#listCache?.projectKey === projectKey) {
      return this.#listCache.value
    }
    if (this.#listInFlight?.projectKey === projectKey) {
      return this.#listInFlight.promise
    }

    const pending = this.#loadList(projectPaths, projectKey, refresh).finally(() => {
      if (this.#listInFlight?.promise === pending) this.#listInFlight = undefined
    })
    this.#listInFlight = { projectKey, promise: pending }
    return pending
  }

  async detail(
    repository: string,
    number: number,
    projectPaths: readonly string[],
    refresh = false,
  ): Promise<PullRequestDetail> {
    const key = targetKey(repository, number)
    const cached = refresh ? undefined : readCache(this.#detailCache, key, this.#now())
    if (cached) return cached
    const existing = this.#detailInFlight.get(key)
    if (existing) return existing

    const pending = this.#loadDetail(repository, number, projectPaths, refresh).finally(() => {
      if (this.#detailInFlight.get(key) === pending) this.#detailInFlight.delete(key)
    })
    this.#detailInFlight.set(key, pending)
    return pending
  }

  async files(
    repository: string,
    number: number,
    page = 1,
    refresh = false,
  ): Promise<PullRequestFilesResult> {
    const key = `${targetKey(repository, number)}:${page}`
    const cached = refresh ? undefined : readCache(this.#filesCache, key, this.#now())
    if (cached) return cached
    const existing = this.#filesInFlight.get(key)
    if (existing) return existing

    const pending = this.#loadFiles(repository, number, page).finally(() => {
      if (this.#filesInFlight.get(key) === pending) this.#filesInFlight.delete(key)
    })
    this.#filesInFlight.set(key, pending)
    return pending
  }

  async metadataOptions(repository: string, refresh = false): Promise<PullRequestMetadataOptions> {
    const key = repository.toLowerCase()
    const cached = refresh ? undefined : readCache(this.#metadataOptionsCache, key, this.#now())
    if (cached) return cached
    const existing = this.#metadataOptionsInFlight.get(key)
    if (existing) return existing

    const pending = this.#loadMetadataOptions(repository).finally(() => {
      if (this.#metadataOptionsInFlight.get(key) === pending) {
        this.#metadataOptionsInFlight.delete(key)
      }
    })
    this.#metadataOptionsInFlight.set(key, pending)
    return pending
  }

  async action(
    repository: string,
    number: number,
    action: PullRequestAction,
  ): Promise<PullRequestActionResult> {
    const url = pullRequestUrl(repository, number)
    let message: string

    switch (action.type) {
      case 'comment':
        await runApiMutation(this.#run, 'POST', `repos/${repository}/issues/${number}/comments`, {
          body: action.body,
        })
        message = 'Comment added'
        break

      case 'review': {
        const flag =
          action.verdict === 'approve'
            ? '--approve'
            : action.verdict === 'request_changes'
              ? '--request-changes'
              : '--comment'
        const args = ['pr', 'review', url, flag]
        if (action.body) args.push('--body-file', '-')
        await this.#run(args, action.body ? { stdin: action.body } : undefined)
        message =
          action.verdict === 'approve'
            ? 'Review approved'
            : action.verdict === 'request_changes'
              ? 'Changes requested'
              : 'Review submitted'
        break
      }

      case 'inline_comment':
        await runApiMutation(this.#run, 'POST', `repos/${repository}/pulls/${number}/comments`, {
          body: action.body,
          commit_id: action.commitId,
          path: action.path,
          line: action.line,
          side: action.side,
        })
        message = 'Inline comment added'
        break

      case 'reply_to_review':
        await runApiMutation(
          this.#run,
          'POST',
          `repos/${repository}/pulls/${number}/comments/${action.commentId}/replies`,
          { body: action.body },
        )
        message = 'Reply added'
        break

      case 'update_comment': {
        const endpoint =
          action.kind === 'issue'
            ? `repos/${repository}/issues/comments/${action.commentId}`
            : `repos/${repository}/pulls/comments/${action.commentId}`
        await runApiMutation(this.#run, 'PATCH', endpoint, { body: action.body })
        message = 'Comment updated'
        break
      }

      case 'delete_comment': {
        const endpoint =
          action.kind === 'issue'
            ? `repos/${repository}/issues/comments/${action.commentId}`
            : `repos/${repository}/pulls/comments/${action.commentId}`
        await runApiMutation(this.#run, 'DELETE', endpoint)
        message = 'Comment deleted'
        break
      }

      case 'resolve_thread': {
        const mutation = action.resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
        const query = `mutation($threadId:ID!){${mutation}(input:{threadId:$threadId}){thread{id}}}`
        await this.#run([
          'api',
          'graphql',
          '-f',
          `query=${query}`,
          '-f',
          `threadId=${action.threadId}`,
        ])
        message = action.resolved ? 'Conversation resolved' : 'Conversation reopened'
        break
      }

      case 'edit': {
        const input = {
          ...(action.title === undefined ? {} : { title: action.title }),
          ...(action.body === undefined ? {} : { body: action.body }),
        }
        if (Object.keys(input).length === 0) {
          throw new Error('Choose a title or description to update')
        }
        await runApiMutation(this.#run, 'PATCH', `repos/${repository}/pulls/${number}`, input)
        message = 'Pull request updated'
        break
      }

      case 'update_metadata': {
        const direct = directMetadataMutation(repository, number, action)
        if (direct) {
          await runApiMutation(this.#run, direct.method, direct.endpoint, direct.input)
        } else {
          const args = ['pr', 'edit', url]
          if (action.baseRefName !== undefined) args.push('--base', action.baseRefName)
          appendFlags(args, '--add-reviewer', action.addReviewers)
          appendFlags(args, '--remove-reviewer', action.removeReviewers)
          appendFlags(args, '--add-assignee', action.addAssignees)
          appendFlags(args, '--remove-assignee', action.removeAssignees)
          appendFlags(args, '--add-label', action.addLabels)
          appendFlags(args, '--remove-label', action.removeLabels)
          if (action.milestone === null) args.push('--remove-milestone')
          else if (action.milestone !== undefined) args.push('--milestone', action.milestone)
          if (args.length === 3) throw new Error('No pull-request metadata changed')
          await this.#run(args)
        }
        message = 'Pull request metadata updated'
        break
      }

      case 'set_draft':
        await this.#run(['pr', 'ready', url, ...(action.draft ? ['--undo'] : [])])
        message = action.draft ? 'Converted to draft' : 'Marked ready for review'
        break

      case 'close':
        await runApiMutation(this.#run, 'PATCH', `repos/${repository}/pulls/${number}`, {
          state: 'closed',
        })
        message = 'Pull request closed'
        break

      case 'reopen':
        await runApiMutation(this.#run, 'PATCH', `repos/${repository}/pulls/${number}`, {
          state: 'open',
        })
        message = 'Pull request reopened'
        break

      case 'update_branch':
        await this.#run(['pr', 'update-branch', url, ...(action.rebase ? ['--rebase'] : [])])
        message = action.rebase ? 'Branch rebased' : 'Base branch merged into pull request'
        break

      case 'rerun_checks':
        await this.#rerunChecks(repository, url, action.failedOnly)
        message = action.failedOnly ? 'Failed checks restarted' : 'Checks restarted'
        break

      case 'merge':
        await this.#run([
          'pr',
          'merge',
          url,
          `--${action.method}`,
          ...(action.deleteBranch ? ['--delete-branch'] : []),
        ])
        message = 'Pull request merged'
        break

      case 'enable_auto_merge':
        await this.#run(['pr', 'merge', url, '--auto', `--${action.method}`])
        message = 'Auto-merge enabled'
        break

      case 'disable_auto_merge':
        await this.#run(['pr', 'merge', url, '--disable-auto'])
        message = 'Auto-merge disabled'
        break
    }

    this.#invalidate(repository, number, action)
    return { message }
  }

  async #loadMetadataOptions(repository: string): Promise<PullRequestMetadataOptions> {
    const endpoint = (path: string) => `repos/${repository}/${path}`
    const [reviewerSource, assigneeSource, labelSource, milestoneSource, branchSource] =
      await Promise.all([
        optionalMetadataSource(
          this.#loadMetadataPages(endpoint('collaborators?per_page=100'), RawActorSchema),
        ),
        optionalMetadataSource(
          this.#loadMetadataPages(endpoint('assignees?per_page=100'), RawActorSchema),
        ),
        optionalMetadataSource(
          this.#loadMetadataPages(endpoint('labels?per_page=100'), RawMetadataLabelSchema),
        ),
        optionalMetadataSource(
          this.#loadMetadataPages(
            endpoint('milestones?state=open&per_page=100'),
            RawMetadataMilestoneSchema,
          ),
        ),
        optionalMetadataSource(
          this.#loadMetadataPages(endpoint('branches?per_page=100'), RawMetadataBranchSchema),
        ),
      ])
    const unavailable: PullRequestMetadataOptions['unavailable'] = []
    if (reviewerSource.unavailable) unavailable.push('reviewers')
    if (assigneeSource.unavailable) unavailable.push('assignees')
    if (labelSource.unavailable) unavailable.push('labels')
    if (milestoneSource.unavailable) unavailable.push('milestones')
    if (branchSource.unavailable) unavailable.push('baseBranches')

    const value: PullRequestMetadataOptions = {
      reviewers: uniqueActors(reviewerSource.items),
      assignees: uniqueActors(assigneeSource.items),
      labels: uniqueMetadataLabels(labelSource.items),
      milestones: uniqueMetadataMilestones(milestoneSource.items),
      baseBranches: uniqueStrings(branchSource.items.flatMap((branch) => branch.name ?? [])).sort(
        compareText,
      ),
      unavailable,
      truncated: [reviewerSource, assigneeSource, labelSource, milestoneSource, branchSource].some(
        (source) => source.truncated,
      ),
    }
    const now = this.#now()
    writeCache(
      this.#metadataOptionsCache,
      repository.toLowerCase(),
      { value, expiresAt: now + METADATA_OPTIONS_TTL_MS },
      METADATA_OPTIONS_CACHE_LIMIT,
      now,
    )
    return value
  }

  async #loadMetadataPages<T>(
    endpoint: string,
    itemSchema: z.ZodType<T>,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const output = await this.#run(['api', endpoint, '--paginate', '--slurp'], {
      maxBytes: 16 * 1024 * 1024,
    })
    const pages = parseJson(
      output,
      `metadata options from ${endpoint}`,
      z.array(z.array(itemSchema)),
    )
    const items = pages.flat()
    return {
      items: items.slice(0, METADATA_OPTIONS_LIMIT),
      truncated: items.length > METADATA_OPTIONS_LIMIT,
    }
  }

  async #loadList(
    projectPaths: readonly string[],
    projectKey: string,
    refresh: boolean,
  ): Promise<PullRequestListResult> {
    const account = await this.#account(refresh)
    if (!account.authenticated) {
      const value = { account, items: [], fetchedAt: this.#now(), truncated: false }
      this.#listCache = { projectKey, value, expiresAt: this.#now() + LIST_TTL_MS }
      return value
    }

    const [
      authored,
      reviewRequested,
      reviewed,
      activeAuthored,
      activeRequested,
      activeReviewed,
      projects,
    ] = await Promise.all([
      this.#searchHistory('authored'),
      this.#searchHistory('review-requested'),
      this.#searchHistory('reviewed'),
      this.#searchActive('authored'),
      this.#searchActive('review-requested'),
      this.#searchActive('reviewed'),
      this.#projects(projectPaths, refresh),
    ])
    const combined = new Map<string, PullRequestListItem>()
    for (const item of [
      ...authored.items,
      ...reviewRequested.items,
      ...reviewed.items,
      ...activeAuthored.items,
      ...activeRequested.items,
      ...activeReviewed.items,
    ]) {
      const existing = combined.get(item.id)
      const relationship =
        existing && existing.relationship !== item.relationship
          ? 'both'
          : (existing?.relationship ?? item.relationship)
      const localProjectPath = projects.get(item.repository.toLowerCase())
      combined.set(item.id, {
        ...(existing ?? item),
        ...item,
        relationship,
        ...(localProjectPath ? { localProjectPath } : {}),
      })
    }
    const items = [...combined.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )
    const value = {
      account,
      items,
      fetchedAt: this.#now(),
      truncated: authored.truncated || reviewRequested.truncated || reviewed.truncated,
    }
    this.#listCache = { projectKey, value, expiresAt: this.#now() + LIST_TTL_MS }
    return value
  }

  async #loadDetail(
    repository: string,
    number: number,
    projectPaths: readonly string[],
    refresh: boolean,
  ): Promise<PullRequestDetail> {
    const url = pullRequestUrl(repository, number)
    const [account, pullRequestOutput, repositoryOutput, threadResult, projects] =
      await Promise.all([
        this.#account(refresh),
        this.#run(['pr', 'view', url, '--json', PULL_REQUEST_FIELDS]),
        this.#repository(repository, refresh),
        this.#cachedReviewThreads(repository, number, refresh),
        this.#projects(projectPaths, refresh),
      ])
    const raw = parseJson(pullRequestOutput, 'pull-request detail', RawPullRequestSchema)
    const repo = repositoryOutput
    const viewerLogin = account.login ?? ''
    const relationship: PullRequestListItem['relationship'] =
      actor(raw.author).login.toLowerCase() === viewerLogin.toLowerCase() ? 'authored' : 'reviewing'
    const comments = (raw.comments ?? [])
      .slice(-100)
      .map((comment) => normalizeComment(comment, viewerLogin))
    const reviews = (raw.reviews ?? [])
      .slice(-100)
      .map((review) => normalizeReview(review, viewerLogin))
    const requestedReviewers = (raw.reviewRequests ?? []).map(actor)
    const reviewers = mergeReviewers(requestedReviewers, reviews)
    const localProjectPath = projects.get(repository.toLowerCase())
    const listItem = normalizeListItem(
      {
        id: raw.id,
        number: raw.number,
        title: raw.title,
        url: raw.url,
        state: raw.state,
        isDraft: raw.isDraft,
        updatedAt: raw.updatedAt,
        additions: raw.additions,
        deletions: raw.deletions,
        comments: { totalCount: comments.length },
        repository: { nameWithOwner: repository },
        ...(!(raw.author === undefined) ? { author: raw.author } : {}),
        ...(!(raw.headRefName === undefined)
          ? {
              headRefName: raw.headRefName,
            }
          : {}),
        ...(!(raw.baseRefName === undefined)
          ? {
              baseRefName: raw.baseRefName,
            }
          : {}),
        ...(!(raw.reviewDecision === undefined)
          ? {
              reviewDecision: raw.reviewDecision,
            }
          : {}),
        ...(!(raw.mergeStateStatus === undefined)
          ? {
              mergeStateStatus: raw.mergeStateStatus,
            }
          : {}),
      },
      relationship,
    )

    const detail: PullRequestDetail = {
      ...listItem,
      ...(localProjectPath ? { localProjectPath } : {}),
      body: raw.body ?? '',
      createdAt: requiredString(raw.createdAt, 'createdAt'),
      ...(raw.closedAt ? { closedAt: raw.closedAt } : {}),
      ...(raw.mergedAt ? { mergedAt: raw.mergedAt } : {}),
      headRefOid: requiredString(raw.headRefOid, 'headRefOid'),
      baseRefOid: requiredString(raw.baseRefOid, 'baseRefOid'),
      changedFiles: raw.changedFiles ?? 0,
      mergeable: normalizeMergeable(raw.mergeable),
      maintainerCanModify: raw.maintainerCanModify === true,
      ...normalizeAutoMerge(raw.autoMergeRequest),
      reviewers,
      requestedReviewers,
      assignees: (raw.assignees ?? []).map(actor),
      labels: (raw.labels ?? []).flatMap((label) =>
        label.name && /^[0-9a-fA-F]{6}$/.test(label.color ?? '')
          ? [{ name: label.name, color: label.color! }]
          : [],
      ),
      ...(raw.milestone?.title ? { milestone: raw.milestone?.title } : {}),
      checks: (raw.statusCheckRollup ?? []).map(normalizeCheck),
      comments,
      reviews,
      reviewThreads: threadResult.threads.map((thread) =>
        normalizeReviewThread(thread, viewerLogin),
      ),
      reviewThreadsTruncated: threadResult.truncated,
      permissions: {
        canPush:
          repo.permissions?.push === true ||
          repo.permissions?.maintain === true ||
          repo.permissions?.admin === true,
        canAdmin: repo.permissions?.admin === true,
      },
      mergeMethods: {
        merge: repo.allow_merge_commit ?? true,
        rebase: repo.allow_rebase_merge ?? true,
        squash: repo.allow_squash_merge ?? true,
        deleteBranchOnMerge: repo.delete_branch_on_merge === true,
      },
    }
    const key = targetKey(repository, number)
    const now = this.#now()
    writeCache(
      this.#detailCache,
      key,
      { value: detail, expiresAt: now + DETAIL_TTL_MS },
      DETAIL_CACHE_LIMIT,
      now,
    )
    return detail
  }

  async #loadFiles(
    repository: string,
    number: number,
    page: number,
  ): Promise<PullRequestFilesResult> {
    const output = await this.#run([
      'api',
      `repos/${repository}/pulls/${number}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`,
    ])
    const raw = parseJson(output, 'pull-request files', z.array(RawFileSchema))
    const files = raw.map(normalizeFile)
    const value = { files, page, hasMore: files.length === FILES_PAGE_SIZE }
    const now = this.#now()
    writeCache(
      this.#filesCache,
      `${targetKey(repository, number)}:${page}`,
      { value, expiresAt: now + FILES_TTL_MS },
      FILES_CACHE_LIMIT,
      now,
    )
    return value
  }

  async #searchHistory(search: PullRequestSearch): Promise<{
    items: PullRequestListItem[]
    truncated: boolean
  }> {
    const flag =
      search === 'authored'
        ? '--author'
        : search === 'review-requested'
          ? '--review-requested'
          : '--reviewed-by'
    const relationship: PullRequestListItem['relationship'] =
      search === 'authored' ? 'authored' : 'reviewing'
    const output = await this.#run([
      'search',
      'prs',
      flag,
      '@me',
      '--limit',
      String(SEARCH_LIMIT),
      '--sort',
      'updated',
      '--order',
      'desc',
      '--json',
      PULL_REQUEST_SEARCH_FIELDS,
    ])
    const raw = parseJson(output, 'pull-request search', z.array(RawSearchCliItemSchema))
    return {
      items: raw.map((item) => normalizeSearchItem(item, relationship)),
      truncated: raw.length >= SEARCH_LIMIT,
    }
  }

  async #searchActive(search: PullRequestSearch): Promise<{
    items: PullRequestListItem[]
    truncated: boolean
  }> {
    const qualifier =
      search === 'authored'
        ? 'author:@me'
        : search === 'review-requested'
          ? 'review-requested:@me'
          : 'reviewed-by:@me'
    const query = `is:pr is:open ${qualifier} sort:updated-desc`
    const relationship: PullRequestListItem['relationship'] =
      search === 'authored' ? 'authored' : 'reviewing'
    const items: PullRequestListItem[] = []
    let cursor: string | undefined
    let hasNextPage = true

    while (hasNextPage && items.length < SEARCH_LIMIT) {
      const args = ['api', 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `q=${query}`]
      if (cursor) args.push('-f', `cursor=${cursor}`)
      const page = parseJson(await this.#run(args), 'pull-request search', RawSearchPageSchema)
      const search = page.data?.search
      for (const node of search?.nodes ?? []) {
        if (node) items.push(normalizeListItem(node, relationship))
      }
      hasNextPage = search?.pageInfo?.hasNextPage === true
      cursor = search?.pageInfo?.endCursor ?? undefined
      if (hasNextPage && !cursor) break
    }

    return { items: items.slice(0, SEARCH_LIMIT), truncated: hasNextPage }
  }

  async #reviewThreads(
    repository: string,
    number: number,
  ): Promise<{ threads: ParsedRawReviewThread[]; truncated: boolean }> {
    const [owner, name] = repository.split('/')
    if (!owner || !name) throw new Error('GitHub repository must have an owner and name')
    const threads: ParsedRawReviewThread[] = []
    let cursor: string | undefined
    let hasNextPage = true

    while (hasNextPage && threads.length < REVIEW_THREAD_LIMIT) {
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${REVIEW_THREADS_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${number}`,
      ]
      if (cursor) args.push('-f', `cursor=${cursor}`)
      const page = parseJson(await this.#run(args), 'review threads', ReviewThreadPageSchema)
      const connection = page.data?.repository?.pullRequest?.reviewThreads
      for (const thread of connection?.nodes ?? []) {
        if (thread) threads.push(thread)
      }
      hasNextPage = connection?.pageInfo?.hasNextPage === true
      cursor = connection?.pageInfo?.endCursor ?? undefined
      if (hasNextPage && !cursor) break
    }

    return { threads: threads.slice(0, REVIEW_THREAD_LIMIT), truncated: hasNextPage }
  }

  async #account(refresh: boolean): Promise<PullRequestAccount> {
    if (!refresh && this.#accountCache && this.#accountCache.expiresAt > this.#now()) {
      return this.#accountCache.value
    }

    let value: PullRequestAccount
    if (!(await this.#installed())) {
      value = {
        available: false,
        authenticated: false,
        error: 'GitHub CLI is not installed',
      }
    } else {
      try {
        const raw = parseJson(await this.#run(['api', 'user']), 'GitHub account', AccountSchema)
        value = raw.login
          ? { available: true, authenticated: true, login: raw.login }
          : {
              available: true,
              authenticated: false,
              error: 'GitHub CLI did not return an account',
            }
      } catch {
        value = {
          available: true,
          authenticated: false,
          error: 'Sign in with `gh auth login` to load pull requests',
        }
      }
    }

    this.#accountCache = { value, expiresAt: this.#now() + ACCOUNT_TTL_MS }
    return value
  }

  async #projects(paths: readonly string[], refresh: boolean): Promise<Map<string, string>> {
    const projectKey = sortedProjectKey(paths)
    if (
      !refresh &&
      this.#projectCache?.projectKey === projectKey &&
      this.#projectCache.expiresAt > this.#now()
    ) {
      return this.#projectCache.value
    }
    const value = await this.#resolveProjects(paths)
    this.#projectCache = { projectKey, value, expiresAt: this.#now() + PROJECTS_TTL_MS }
    return value
  }

  async #repository(repository: string, refresh: boolean): Promise<ParsedRawRepository> {
    const key = repository.toLowerCase()
    const cached = refresh ? undefined : readCache(this.#repositoryCache, key, this.#now())
    if (cached) return cached
    const existing = this.#repositoryInFlight.get(key)
    if (existing) return existing

    const pending = this.#run(['api', `repos/${repository}`])
      .then((output) => parseJson(output, 'repository detail', RawRepositorySchema))
      .catch(() => ({}))
      .then((value) => {
        const now = this.#now()
        writeCache(
          this.#repositoryCache,
          key,
          { value, expiresAt: now + REPOSITORY_TTL_MS },
          REPOSITORY_CACHE_LIMIT,
          now,
        )
        return value
      })
      .finally(() => {
        if (this.#repositoryInFlight.get(key) === pending) this.#repositoryInFlight.delete(key)
      })
    this.#repositoryInFlight.set(key, pending)
    return pending
  }

  async #cachedReviewThreads(
    repository: string,
    number: number,
    refresh: boolean,
  ): Promise<ReviewThreadsResult> {
    const key = targetKey(repository, number)
    const cached = refresh ? undefined : readCache(this.#reviewThreadsCache, key, this.#now())
    if (cached) return cached
    const existing = this.#reviewThreadsInFlight.get(key)
    if (existing) return existing

    const pending = this.#reviewThreads(repository, number)
      .catch(() => ({ threads: [], truncated: true }))
      .then((value) => {
        const now = this.#now()
        writeCache(
          this.#reviewThreadsCache,
          key,
          { value, expiresAt: now + REVIEW_THREADS_TTL_MS },
          REVIEW_THREADS_CACHE_LIMIT,
          now,
        )
        return value
      })
      .finally(() => {
        if (this.#reviewThreadsInFlight.get(key) === pending) {
          this.#reviewThreadsInFlight.delete(key)
        }
      })
    this.#reviewThreadsInFlight.set(key, pending)
    return pending
  }

  async #rerunChecks(repository: string, url: string, failedOnly: boolean): Promise<void> {
    const output = await this.#run([
      'pr',
      'checks',
      url,
      '--json',
      'bucket,link,name,state,workflow',
    ])
    const checks = parseJson(output, 'pull-request checks', z.array(CheckRunSchema))
    const runIds = new Set<string>()
    for (const check of checks) {
      if (failedOnly && check.bucket !== 'fail' && check.bucket !== 'cancel') continue
      const runId = /\/actions\/runs\/(\d+)/.exec(check.link ?? '')?.[1]
      if (runId) runIds.add(runId)
    }
    if (runIds.size === 0) throw new Error('No GitHub Actions runs are available to restart')
    await Promise.all(
      [...runIds].map((runId) =>
        this.#run([
          'run',
          'rerun',
          runId,
          '--repo',
          repository,
          ...(failedOnly ? ['--failed'] : []),
        ]),
      ),
    )
  }

  #invalidate(repository: string, number: number, action: PullRequestAction): void {
    const target = targetKey(repository, number)
    const cachedList = this.#listCache
    if (cachedList) {
      const items = cachedList.value.items.map((item) =>
        targetKey(item.repository, item.number) === target
          ? applyActionToListItem(item, action)
          : item,
      )
      this.#listCache = {
        ...cachedList,
        value: { ...cachedList.value, items },
      }
    }

    this.#detailCache.delete(target)

    if (action.type === 'update_branch') {
      for (const key of this.#filesCache.keys()) {
        if (key.startsWith(`${target}:`)) this.#filesCache.delete(key)
      }
    }

    if (actionChangesReviewThreads(action)) this.#reviewThreadsCache.delete(target)
  }
}

function applyActionToListItem(
  item: PullRequestListItem,
  action: PullRequestAction,
): PullRequestListItem {
  switch (action.type) {
    case 'comment':
      return { ...item, commentsCount: item.commentsCount + 1 }
    case 'edit':
      return {
        ...item,
        ...(action.title === undefined ? {} : { title: action.title }),
      }
    case 'update_metadata':
      return {
        ...item,
        ...(action.baseRefName === undefined ? {} : { baseRefName: action.baseRefName }),
      }
    case 'set_draft':
      return { ...item, state: 'OPEN', isDraft: action.draft }
    case 'close':
      return { ...item, state: 'CLOSED' }
    case 'reopen':
      return { ...item, state: 'OPEN' }
    case 'merge':
      return { ...item, state: 'MERGED', isDraft: false }
    default:
      return item
  }
}

function actionChangesReviewThreads(action: PullRequestAction): boolean {
  return (
    action.type === 'inline_comment' ||
    action.type === 'reply_to_review' ||
    action.type === 'resolve_thread' ||
    ((action.type === 'update_comment' || action.type === 'delete_comment') &&
      action.kind === 'review')
  )
}

async function runApiMutation(
  run: GhRunner,
  method: ApiMutation['method'],
  endpoint: string,
  input?: Record<string, JsonValue>,
): Promise<void> {
  if (input === undefined) {
    await run(['api', '--silent', '--method', method, endpoint])
    return
  }

  await run(['api', '--silent', '--method', method, endpoint, '--input', '-'], {
    stdin: JSON.stringify(input),
  })
}

function directMetadataMutation(
  repository: string,
  number: number,
  action: UpdateMetadataAction,
): ApiMutation | undefined {
  const hasReviewers = action.addReviewers.length > 0 || action.removeReviewers.length > 0
  const hasAssignees = action.addAssignees.length > 0 || action.removeAssignees.length > 0
  const hasLabels = action.addLabels.length > 0 || action.removeLabels.length > 0
  const changedGroups = [
    action.baseRefName !== undefined,
    hasReviewers,
    hasAssignees,
    hasLabels,
    action.milestone !== undefined,
  ].filter(Boolean).length

  // The direct endpoints make the common one-click picker actions a single API call.
  // Keep gh pr edit as the atomic fallback for changes spanning multiple metadata groups.
  if (changedGroups !== 1) return undefined

  if (action.baseRefName !== undefined) {
    return {
      method: 'PATCH',
      endpoint: `repos/${repository}/pulls/${number}`,
      input: { base: action.baseRefName },
    }
  }

  if (hasReviewers) {
    if (action.addReviewers.length > 0 && action.removeReviewers.length === 0) {
      return {
        method: 'POST',
        endpoint: `repos/${repository}/pulls/${number}/requested_reviewers`,
        input: { reviewers: action.addReviewers },
      }
    }
    if (action.removeReviewers.length > 0 && action.addReviewers.length === 0) {
      return {
        method: 'DELETE',
        endpoint: `repos/${repository}/pulls/${number}/requested_reviewers`,
        input: { reviewers: action.removeReviewers },
      }
    }
    return undefined
  }

  if (hasAssignees) {
    if (action.addAssignees.length > 0 && action.removeAssignees.length === 0) {
      return {
        method: 'POST',
        endpoint: `repos/${repository}/issues/${number}/assignees`,
        input: { assignees: action.addAssignees },
      }
    }
    if (action.removeAssignees.length > 0 && action.addAssignees.length === 0) {
      return {
        method: 'DELETE',
        endpoint: `repos/${repository}/issues/${number}/assignees`,
        input: { assignees: action.removeAssignees },
      }
    }
    return undefined
  }

  if (hasLabels) {
    if (action.addLabels.length > 0 && action.removeLabels.length === 0) {
      return {
        method: 'POST',
        endpoint: `repos/${repository}/issues/${number}/labels`,
        input: { labels: action.addLabels },
      }
    }
    if (action.removeLabels.length === 1 && action.addLabels.length === 0) {
      return {
        method: 'DELETE',
        endpoint: `repos/${repository}/issues/${number}/labels/${encodeURIComponent(action.removeLabels[0]!)}`,
      }
    }
  }

  return undefined
}

async function optionalMetadataSource<T>(
  pending: Promise<{ items: T[]; truncated: boolean }>,
): Promise<MetadataSource<T>> {
  try {
    return { ...(await pending), unavailable: false }
  } catch {
    return { items: [], truncated: false, unavailable: true }
  }
}

function uniqueActors(values: ParsedRawActor[]): PullRequestMetadataOptions['reviewers'] {
  const actors = new Map<string, PullRequestMetadataOptions['reviewers'][number]>()
  for (const value of values) {
    const login = value.login?.trim()
    if (!login) continue
    const key = login.toLowerCase()
    if (!actors.has(key)) {
      actors.set(key, {
        login,
        isBot: value.is_bot === true || value.type === 'Bot' || login.endsWith('[bot]'),
      })
    }
  }
  return [...actors.values()].sort((left, right) => compareText(left.login, right.login))
}

function uniqueMetadataLabels(
  values: ParsedRawMetadataLabel[],
): PullRequestMetadataOptions['labels'] {
  const labels = new Map<string, PullRequestMetadataOptions['labels'][number]>()
  for (const value of values) {
    const name = value.name?.trim()
    const color = value.color?.trim()
    if (!name || !color || !/^[0-9a-fA-F]{6}$/.test(color)) continue
    const key = name.toLowerCase()
    if (!labels.has(key)) {
      const description = value.description?.trim()
      labels.set(key, {
        name,
        color,
        ...(description
          ? {
              description: description,
            }
          : {}),
      })
    }
  }
  return [...labels.values()].sort((left, right) => compareText(left.name, right.name))
}

function uniqueMetadataMilestones(
  values: ParsedRawMetadataMilestone[],
): PullRequestMetadataOptions['milestones'] {
  const milestones = new Map<number, PullRequestMetadataOptions['milestones'][number]>()
  for (const value of values) {
    const title = value.title?.trim()
    if (!title || !Number.isInteger(value.number) || (value.number ?? 0) < 1) continue
    if (!milestones.has(value.number!))
      milestones.set(value.number!, { number: value.number!, title })
  }
  return [...milestones.values()].sort((left, right) => compareText(left.title, right.title))
}

function uniqueStrings(values: string[]): string[] {
  const unique = new Map<string, string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed && !unique.has(trimmed.toLowerCase())) unique.set(trimmed.toLowerCase(), trimmed)
  }
  return [...unique.values()]
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

/** The only process boundary used by the feature; bodies always travel over stdin. */
export function runGh(args: string[], options: GhRunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli('gh', args)
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_LIMIT
    const finish = (result: string | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish(new Error('GitHub did not respond in time'))
    }, options.timeoutMs ?? 30_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxBytes) {
        killTree(child)
        finish(new Error('GitHub response was too large to display safely'))
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (settled) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxBytes) {
        killTree(child)
        finish(new Error('GitHub response was too large to display safely'))
        return
      }
      stderr += chunk
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code === 0) finish(stdout)
      else
        finish(new Error(firstUsefulLine(stderr) || firstUsefulLine(stdout) || 'GitHub CLI failed'))
    })
    child.stdin.end(options.stdin)
  })
}

export async function resolveProjectRepositories(
  paths: readonly string[],
): Promise<Map<string, string>> {
  const matches = new Map<string, string>()
  await Promise.all(
    paths.map(async (projectPath) => {
      try {
        const { stdout } = await runFile('git', ['config', '--get', 'remote.origin.url'], {
          cwd: projectPath,
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        })
        const repository = githubRepositoryFromRemote(stdout.trim())
        if (repository && !matches.has(repository.toLowerCase())) {
          matches.set(repository.toLowerCase(), projectPath)
        }
      } catch {
        // A configured project without a GitHub origin is a normal local project.
      }
    }),
  )
  return matches
}

export function githubRepositoryFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/i, '')
  const scp = /^git@github\.com:([^/]+\/[^/]+)$/i.exec(trimmed)
  if (scp) return scp[1]
  try {
    const url = new URL(trimmed)
    if (url.hostname.toLowerCase() !== 'github.com') return undefined
    const repository = url.pathname.replace(/^\/+|\/+$/g, '')
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : undefined
  } catch {
    return undefined
  }
}

function normalizeSearchItem(
  raw: ParsedRawSearchCliItem,
  relationship: PullRequestListItem['relationship'],
): PullRequestListItem {
  return normalizeListItem(
    {
      id: requiredString(raw.id, 'id'),
      number: requiredNumber(raw.number, 'number'),
      title: requiredString(raw.title, 'title'),
      url: requiredString(raw.url, 'url'),
      state: requiredString(raw.state, 'state'),
      isDraft: raw.isDraft === true,
      updatedAt: requiredString(raw.updatedAt, 'updatedAt'),
      additions: 0,
      deletions: 0,
      comments: { totalCount: nonnegative(raw.commentsCount) },
      ...(!(raw.author === undefined) ? { author: raw.author } : {}),
      repository: {
        nameWithOwner: requiredString(raw.repository?.nameWithOwner, 'repository'),
      },
    },
    relationship,
  )
}

function normalizeListItem(
  raw: ParsedRawSearchNode,
  relationship: PullRequestListItem['relationship'],
): PullRequestListItem {
  const repository = requiredString(raw.repository?.nameWithOwner, 'repository')
  const reviewDecision = normalizeReviewDecision(raw.reviewDecision)
  return {
    id: requiredString(raw.id, 'id'),
    repository,
    number: requiredNumber(raw.number, 'number'),
    title: requiredString(raw.title, 'title'),
    url: requiredString(raw.url, 'url'),
    author: actor(raw.author),
    updatedAt: requiredString(raw.updatedAt, 'updatedAt'),
    isDraft: raw.isDraft === true,
    state: normalizeState(raw.state),
    additions: nonnegative(raw.additions),
    deletions: nonnegative(raw.deletions),
    commentsCount: nonnegative(raw.comments?.totalCount),
    headRefName: raw.headRefName ?? '',
    baseRefName: raw.baseRefName ?? '',
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(raw.mergeStateStatus
      ? {
          mergeStateStatus: raw.mergeStateStatus,
        }
      : {}),
    relationship,
  }
}

function normalizeComment(raw: ParsedRawComment, viewerLogin: string): PullRequestComment {
  const url = raw.url ?? 'https://github.com/'
  const author = actor(raw.author)
  const parsedDatabaseId = Number(/(?:issuecomment|discussion_r)-(\d+)/.exec(url)?.[1] ?? 0)
  const databaseId = raw.databaseId ?? (parsedDatabaseId || undefined)
  return {
    id: raw.id ?? `${author.login}:${raw.createdAt ?? ''}`,
    ...(databaseId ? { databaseId } : {}),
    author,
    body: raw.body ?? '',
    createdAt: requiredString(raw.createdAt, 'comment.createdAt'),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    url,
    viewerDidAuthor: author.login.toLowerCase() === viewerLogin.toLowerCase(),
  }
}

function normalizeReview(raw: ParsedRawReview, viewerLogin: string): PullRequestReview {
  const author = actor(raw.author)
  return {
    id: raw.id ?? `${author.login}:${raw.submittedAt ?? ''}`,
    author,
    body: raw.body ?? '',
    state: normalizeReviewState(raw.state, false),
    submittedAt: requiredString(raw.submittedAt, 'review.submittedAt'),
    viewerDidAuthor: author.login.toLowerCase() === viewerLogin.toLowerCase(),
  }
}

function normalizeReviewThread(
  raw: ParsedRawReviewThread,
  viewerLogin: string,
): PullRequestReviewThread {
  const diffSide: PullRequestReviewThread['diffSide'] =
    raw.diffSide === 'LEFT' || raw.diffSide === 'RIGHT' ? raw.diffSide : undefined
  const startDiffSide: PullRequestReviewThread['startDiffSide'] =
    raw.startDiffSide === 'LEFT' || raw.startDiffSide === 'RIGHT' ? raw.startDiffSide : undefined
  return {
    id: requiredString(raw.id, 'reviewThread.id'),
    path: requiredString(raw.path, 'reviewThread.path'),
    ...(raw.line ? { line: raw.line } : {}),
    ...(raw.startLine ? { startLine: raw.startLine } : {}),
    ...(raw.originalLine ? { originalLine: raw.originalLine } : {}),
    ...(raw.originalStartLine
      ? {
          originalStartLine: raw.originalStartLine,
        }
      : {}),
    ...(diffSide ? { diffSide: diffSide } : {}),
    ...(startDiffSide
      ? {
          startDiffSide: startDiffSide,
        }
      : {}),
    resolved: raw.isResolved === true,
    outdated: raw.isOutdated === true,
    comments: (raw.comments?.nodes ?? []).map((comment) => normalizeComment(comment, viewerLogin)),
  }
}

function normalizeCheck(raw: ParsedRawCheck): PullRequestDetail['checks'][number] {
  const checkRun = raw.__typename === 'CheckRun'
  const name = checkRun ? raw.name : raw.context
  const detailsUrl = checkRun ? raw.detailsUrl : raw.targetUrl
  return {
    name: name || 'Check',
    ...(raw.workflowName ? { workflowName: raw.workflowName } : {}),
    state: checkState(raw),
    ...(detailsUrl && isUrl(detailsUrl) ? { detailsUrl } : {}),
    ...(raw.startedAt ? { startedAt: raw.startedAt } : {}),
    ...(raw.completedAt ? { completedAt: raw.completedAt } : {}),
  }
}

function normalizeFile(raw: z.infer<typeof RawFileSchema>): PullRequestFile {
  const status = raw.status
  const validStatus =
    status === 'added' ||
    status === 'removed' ||
    status === 'modified' ||
    status === 'renamed' ||
    status === 'copied' ||
    status === 'changed' ||
    status === 'unchanged'
      ? status
      : 'modified'
  const blobUrl = raw.blob_url && isUrl(raw.blob_url) ? raw.blob_url : undefined
  return {
    sha: requiredString(raw.sha, 'file.sha'),
    path: requiredString(raw.filename, 'file.filename'),
    ...(raw.previous_filename === undefined ? {} : { previousPath: raw.previous_filename }),
    status: validStatus,
    additions: nonnegative(raw.additions),
    deletions: nonnegative(raw.deletions),
    changes: nonnegative(raw.changes),
    ...(raw.patch === undefined ? {} : { patch: raw.patch }),
    ...(blobUrl ? { blobUrl } : {}),
  }
}

function mergeReviewers(
  requested: PullRequestDetail['requestedReviewers'],
  reviews: PullRequestReview[],
): PullRequestReviewer[] {
  const byLogin = new Map<string, PullRequestReviewer>()
  for (const review of reviews) {
    const key = review.author.login.toLowerCase()
    const existing = byLogin.get(key)
    if (
      !existing ||
      existing.submittedAt === undefined ||
      Date.parse(review.submittedAt) >= Date.parse(existing.submittedAt)
    ) {
      byLogin.set(key, {
        actor: review.author,
        state: review.state,
        submittedAt: review.submittedAt,
      })
    }
  }
  // reviewRequests is GitHub's current pending state. It must win over an
  // older submitted review when someone was re-requested after new commits.
  for (const actorValue of requested) {
    byLogin.set(actorValue.login.toLowerCase(), { actor: actorValue, state: 'REQUESTED' })
  }
  return [...byLogin.values()]
}

function normalizeAutoMerge(
  raw: ParsedRawPullRequest['autoMergeRequest'],
): Pick<PullRequestDetail, 'autoMerge'> | null {
  if (!raw?.mergeMethod) return null
  const mergeMethod = raw.mergeMethod.toUpperCase()
  if (mergeMethod !== 'MERGE' && mergeMethod !== 'REBASE' && mergeMethod !== 'SQUASH') return null
  return {
    autoMerge: {
      mergeMethod,
      ...(raw.enabledAt ? { enabledAt: raw.enabledAt } : {}),
      ...(raw.enabledBy ? { enabledBy: actor(raw.enabledBy) } : {}),
    },
  }
}

function actor(raw: ParsedRawActor | null | undefined): PullRequestDetail['author'] {
  const login = raw?.login || raw?.slug || raw?.name || 'ghost'
  return { login, isBot: raw?.is_bot === true || /(?:\[bot\]|-bot$|bot$)/i.test(login) }
}

function normalizeState(state: string | undefined): PullRequestListItem['state'] {
  const normalized = state?.toUpperCase()
  if (normalized === 'CLOSED' || normalized === 'MERGED') return normalized
  return 'OPEN'
}

function normalizeMergeable(value: string | undefined): PullRequestDetail['mergeable'] {
  if (value === 'MERGEABLE' || value === 'CONFLICTING') return value
  return 'UNKNOWN'
}

function normalizeReviewDecision(
  value: string | null | undefined,
): PullRequestListItem['reviewDecision'] {
  if (value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') {
    return value
  }
  return undefined
}

function normalizeReviewState(value: string | undefined, requested: true): PullRequestReviewState
function normalizeReviewState(
  value: string | undefined,
  requested: false,
): Exclude<PullRequestReviewState, 'REQUESTED'>
function normalizeReviewState(
  value: string | undefined,
  requested: boolean,
): PullRequestReviewState {
  if (requested) return 'REQUESTED'
  if (
    value === 'APPROVED' ||
    value === 'CHANGES_REQUESTED' ||
    value === 'COMMENTED' ||
    value === 'DISMISSED' ||
    value === 'PENDING'
  ) {
    return value
  }
  return 'COMMENTED'
}

function checkState(raw: ParsedRawCheck): PullRequestDetail['checks'][number]['state'] {
  const value = (raw.conclusion || raw.state || raw.status || '').toUpperCase()
  if (value === 'SUCCESS') return 'success'
  if (
    value === 'FAILURE' ||
    value === 'ERROR' ||
    value === 'TIMED_OUT' ||
    value === 'ACTION_REQUIRED'
  ) {
    return 'failure'
  }
  if (value === 'CANCELLED') return 'cancelled'
  if (value === 'SKIPPED') return 'skipped'
  if (value === 'NEUTRAL' || value === 'STALE') return 'neutral'
  return 'pending'
}

function parseJson<T>(output: string, label: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(output))
  } catch {
    throw new Error(`GitHub returned invalid ${label} data`)
  }
}

function requiredString(value: string | null | undefined, field: string): string {
  if (!value) {
    throw new Error(`GitHub response is missing ${field}`)
  }
  return value
}

function requiredNumber(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`GitHub response is missing ${field}`)
  }
  return value
}

function nonnegative(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

function isUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function appendFlags(args: string[], flag: string, values: readonly string[]): void {
  for (const value of values) args.push(flag, value)
}

function pullRequestUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`
}

function targetKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`
}

function sortedProjectKey(paths: readonly string[]): string {
  return [...paths].sort().join('\u0000')
}

function firstUsefulLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}
