import { z } from 'zod'

export const GitHubRepositoryNameSchema = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/repository')
  .refine(
    (value) => value.split('/').every((segment) => segment !== '.' && segment !== '..'),
    'expected owner/repository',
  )
export type GitHubRepositoryName = z.infer<typeof GitHubRepositoryNameSchema>

export const PullRequestTargetSchema = z.object({
  repository: GitHubRepositoryNameSchema,
  number: z.number().int().positive(),
})
export type PullRequestTarget = z.infer<typeof PullRequestTargetSchema>

export const GitHubActorSchema = z.object({
  login: z.string().min(1),
  isBot: z.boolean(),
})
export type GitHubActor = z.infer<typeof GitHubActorSchema>

export const PullRequestStateSchema = z.enum(['OPEN', 'CLOSED', 'MERGED'])
export type PullRequestState = z.infer<typeof PullRequestStateSchema>

export const PullRequestRelationshipSchema = z.enum(['authored', 'reviewing', 'both'])
export type PullRequestRelationship = z.infer<typeof PullRequestRelationshipSchema>

export const PullRequestListItemSchema = PullRequestTargetSchema.extend({
  id: z.string().min(1),
  title: z.string(),
  url: z.string().url().startsWith('https://github.com/'),
  author: GitHubActorSchema,
  updatedAt: z.string().datetime({ offset: true }),
  isDraft: z.boolean(),
  state: PullRequestStateSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  commentsCount: z.number().int().nonnegative(),
  headRefName: z.string(),
  baseRefName: z.string(),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).optional(),
  mergeStateStatus: z.string().optional(),
  relationship: PullRequestRelationshipSchema,
  /** Configured Harness project whose origin points at this repository. */
  localProjectPath: z.string().min(1).optional(),
})
export type PullRequestListItem = z.infer<typeof PullRequestListItemSchema>

export const PullRequestAccountSchema = z.object({
  available: z.boolean(),
  authenticated: z.boolean(),
  login: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
})
export type PullRequestAccount = z.infer<typeof PullRequestAccountSchema>

export const PullRequestListResultSchema = z.object({
  account: PullRequestAccountSchema,
  items: z.array(PullRequestListItemSchema),
  fetchedAt: z.number().int().nonnegative(),
  truncated: z.boolean(),
})
export type PullRequestListResult = z.infer<typeof PullRequestListResultSchema>

export const PullRequestLabelSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
})
export type PullRequestLabel = z.infer<typeof PullRequestLabelSchema>

export const PullRequestReviewStateSchema = z.enum([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
  'REQUESTED',
])
export type PullRequestReviewState = z.infer<typeof PullRequestReviewStateSchema>

export const PullRequestReviewerSchema = z.object({
  actor: GitHubActorSchema,
  state: PullRequestReviewStateSchema,
  submittedAt: z.string().datetime({ offset: true }).optional(),
})
export type PullRequestReviewer = z.infer<typeof PullRequestReviewerSchema>

export const PullRequestCheckSchema = z.object({
  name: z.string().min(1),
  workflowName: z.string().optional(),
  state: z.enum(['success', 'failure', 'pending', 'neutral', 'skipped', 'cancelled']),
  detailsUrl: z.string().url().optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional(),
})
export type PullRequestCheck = z.infer<typeof PullRequestCheckSchema>

export const PullRequestCommentSchema = z.object({
  id: z.string().min(1),
  databaseId: z.number().int().positive().optional(),
  author: GitHubActorSchema,
  body: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  url: z.string().url(),
  viewerDidAuthor: z.boolean(),
})
export type PullRequestComment = z.infer<typeof PullRequestCommentSchema>

export const PullRequestReviewSchema = z.object({
  id: z.string().min(1),
  author: GitHubActorSchema,
  body: z.string(),
  state: PullRequestReviewStateSchema.exclude(['REQUESTED']),
  submittedAt: z.string().datetime({ offset: true }),
  viewerDidAuthor: z.boolean(),
})
export type PullRequestReview = z.infer<typeof PullRequestReviewSchema>

export const PullRequestReviewThreadSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  originalLine: z.number().int().positive().optional(),
  originalStartLine: z.number().int().positive().optional(),
  diffSide: z.enum(['LEFT', 'RIGHT']).optional(),
  startDiffSide: z.enum(['LEFT', 'RIGHT']).optional(),
  resolved: z.boolean(),
  outdated: z.boolean(),
  comments: z.array(PullRequestCommentSchema),
  /** Later replies exist on GitHub beyond the comments returned here. */
  commentsTruncated: z.boolean().optional(),
})
export type PullRequestReviewThread = z.infer<typeof PullRequestReviewThreadSchema>

export const PullRequestDetailSchema = PullRequestListItemSchema.extend({
  body: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).optional(),
  mergedAt: z.string().datetime({ offset: true }).optional(),
  headRefOid: z.string().min(1),
  baseRefOid: z.string().min(1),
  changedFiles: z.number().int().nonnegative(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  maintainerCanModify: z.boolean(),
  autoMerge: z
    .object({
      mergeMethod: z.enum(['MERGE', 'REBASE', 'SQUASH']),
      enabledAt: z.string().datetime({ offset: true }).optional(),
      enabledBy: GitHubActorSchema.optional(),
    })
    .optional(),
  reviewers: z.array(PullRequestReviewerSchema),
  requestedReviewers: z.array(GitHubActorSchema),
  assignees: z.array(GitHubActorSchema),
  labels: z.array(PullRequestLabelSchema),
  milestone: z.string().min(1).optional(),
  checks: z.array(PullRequestCheckSchema),
  comments: z.array(PullRequestCommentSchema),
  reviews: z.array(PullRequestReviewSchema),
  reviewThreads: z.array(PullRequestReviewThreadSchema),
  reviewThreadsTruncated: z.boolean(),
  /** The conversation read failed; reviewThreads is empty rather than complete. */
  reviewThreadsUnavailable: z.boolean().optional(),
  permissions: z.object({
    canPush: z.boolean(),
    canAdmin: z.boolean(),
  }),
  mergeMethods: z.object({
    merge: z.boolean(),
    rebase: z.boolean(),
    squash: z.boolean(),
    deleteBranchOnMerge: z.boolean(),
  }),
})
export type PullRequestDetail = z.infer<typeof PullRequestDetailSchema>

export const PullRequestFileSchema = z.object({
  sha: z.string().min(1),
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().optional(),
  blobUrl: z.string().url().optional(),
})
export type PullRequestFile = z.infer<typeof PullRequestFileSchema>

export const PullRequestFilesResultSchema = z.object({
  headRefOid: z.string().min(1),
  baseRefOid: z.string().min(1),
  files: z.array(PullRequestFileSchema),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
})
export type PullRequestFilesResult = z.infer<typeof PullRequestFilesResultSchema>

export const PullRequestMetadataLabelSchema = PullRequestLabelSchema.extend({
  description: z.string().optional(),
})
export type PullRequestMetadataLabel = z.infer<typeof PullRequestMetadataLabelSchema>

export const PullRequestMetadataMilestoneSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
})
export type PullRequestMetadataMilestone = z.infer<typeof PullRequestMetadataMilestoneSchema>

export const PullRequestMetadataOptionsSchema = z.object({
  reviewers: z.array(GitHubActorSchema),
  assignees: z.array(GitHubActorSchema),
  labels: z.array(PullRequestMetadataLabelSchema),
  milestones: z.array(PullRequestMetadataMilestoneSchema),
  baseBranches: z.array(z.string().min(1)),
  unavailable: z.array(z.enum(['reviewers', 'assignees', 'labels', 'milestones', 'baseBranches'])),
  truncated: z.boolean(),
})
export type PullRequestMetadataOptions = z.infer<typeof PullRequestMetadataOptionsSchema>

const PullRequestTextSchema = z.string().min(1).max(1_000_000)
const PullRequestNamesSchema = z.array(z.string().trim().min(1).max(200)).max(100)

export const PullRequestActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('comment'), body: PullRequestTextSchema }),
  z.object({
    type: z.literal('review'),
    verdict: z.enum(['approve', 'comment', 'request_changes']),
    body: z.string().max(1_000_000),
    /** Head commit the user inspected; GitHub binds the review to it. */
    commitId: z.string().min(1),
  }),
  z.object({
    type: z.literal('inline_comment'),
    body: PullRequestTextSchema,
    commitId: z.string().min(1),
    path: z.string().min(1).max(4096),
    line: z.number().int().positive(),
    side: z.enum(['LEFT', 'RIGHT']),
  }),
  z.object({
    type: z.literal('reply_to_review'),
    commentId: z.number().int().positive(),
    body: PullRequestTextSchema,
  }),
  z.object({
    type: z.literal('update_comment'),
    kind: z.enum(['issue', 'review']),
    commentId: z.number().int().positive(),
    body: PullRequestTextSchema,
  }),
  z.object({
    type: z.literal('delete_comment'),
    kind: z.enum(['issue', 'review']),
    commentId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('resolve_thread'),
    threadId: z.string().min(1),
    resolved: z.boolean(),
  }),
  z.object({
    type: z.literal('edit'),
    title: z.string().trim().min(1).max(256).optional(),
    body: z.string().max(1_000_000).optional(),
  }),
  z.object({
    type: z.literal('update_metadata'),
    baseRefName: z.string().trim().min(1).max(255).optional(),
    addReviewers: PullRequestNamesSchema,
    removeReviewers: PullRequestNamesSchema,
    addAssignees: PullRequestNamesSchema,
    removeAssignees: PullRequestNamesSchema,
    addLabels: PullRequestNamesSchema,
    removeLabels: PullRequestNamesSchema,
    milestone: z.string().trim().min(1).max(255).nullable().optional(),
  }),
  z.object({ type: z.literal('set_draft'), draft: z.boolean() }),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('reopen') }),
  z.object({ type: z.literal('update_branch'), rebase: z.boolean() }),
  z.object({ type: z.literal('rerun_checks'), failedOnly: z.boolean() }),
  z.object({
    type: z.literal('merge'),
    method: z.enum(['merge', 'rebase', 'squash']),
    deleteBranch: z.boolean(),
    /** Head commit the user reviewed; the merge fails if the branch has moved since. */
    expectedHeadOid: z.string().min(1),
  }),
  z.object({
    type: z.literal('enable_auto_merge'),
    method: z.enum(['merge', 'rebase', 'squash']),
    /** Head commit the user reviewed; auto-merge is refused if the branch has moved since. */
    expectedHeadOid: z.string().min(1),
  }),
  z.object({ type: z.literal('disable_auto_merge') }),
])
export type PullRequestAction = z.infer<typeof PullRequestActionSchema>

export const PullRequestActionResultSchema = z.object({ message: z.string().min(1) })
export type PullRequestActionResult = z.infer<typeof PullRequestActionResultSchema>

/** A branch name the server passes to git or gh as one argument, never as an option. */
const BranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith('-') && !/[\s\0]/.test(value), 'expected a branch name')

/** All checks folded into one word. `none` means the head commit has no checks. */
export const PullRequestChecksSummarySchema = z.enum(['passing', 'failing', 'pending', 'none'])
export type PullRequestChecksSummary = z.infer<typeof PullRequestChecksSummarySchema>

/** The pull request whose head is a checkout's branch, as much as a header chip needs. */
export const CheckoutPullRequestSchema = PullRequestTargetSchema.extend({
  title: z.string(),
  url: z.string().url().startsWith('https://github.com/'),
  state: PullRequestStateSchema,
  isDraft: z.boolean(),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).optional(),
  checks: PullRequestChecksSummarySchema.optional(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1).optional(),
})
export type CheckoutPullRequest = z.infer<typeof CheckoutPullRequestSchema>

/**
 * Why a checkout's pull request could not be looked up. `not_git`: the folder
 * is not a git checkout. `no_branch`: the repository has no commit yet.
 * `detached`: HEAD is not on a branch. `no_remote`: no GitHub remote.
 * `gh_missing` and `signed_out`: the GitHub CLI cannot answer. `failed`: the
 * lookup ran and did not finish.
 */
export const CheckoutPullRequestUnavailableSchema = z.enum([
  'not_git',
  'no_branch',
  'detached',
  'no_remote',
  'gh_missing',
  'signed_out',
  'failed',
])
export type CheckoutPullRequestUnavailable = z.infer<typeof CheckoutPullRequestUnavailableSchema>

export const CheckoutPullRequestResultSchema = z
  .object({
    /** The lookup ran. False comes with a `reason`. */
    available: z.boolean(),
    reason: CheckoutPullRequestUnavailableSchema.optional(),
    /** The checkout's branch, when HEAD is on one. */
    branch: z.string().min(1).optional(),
    /** The GitHub repository the checkout's remote points at. */
    repository: GitHubRepositoryNameSchema.optional(),
    /** The repository's default branch, which never gets a pull request of its own. */
    defaultBranch: z.string().min(1).optional(),
    /** The branch's upstream, such as "origin/feature"; absent before the first push. */
    upstream: z.string().min(1).optional(),
    /** Commits on the branch that its upstream does not have yet. */
    ahead: z.number().int().nonnegative().optional(),
    /** Absent when the branch has no pull request, open or closed. */
    pullRequest: CheckoutPullRequestSchema.optional(),
    fetchedAt: z.number().int().nonnegative(),
  })
  .superRefine((result, context) => {
    if (result.available === (result.reason !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is required exactly when the lookup is unavailable',
      })
    }
    if (!result.available && result.pullRequest) {
      context.addIssue({
        code: 'custom',
        path: ['pullRequest'],
        message: 'an unavailable lookup has no pull request',
      })
    }
  })
export type CheckoutPullRequestResult = z.infer<typeof CheckoutPullRequestResultSchema>

/** Open a pull request from a checkout's pushed branch. The server runs gh. */
export const PullRequestCreateSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(1_000_000),
  /** Target branch. Absent means the repository's default branch. */
  base: BranchNameSchema.optional(),
  draft: z.boolean(),
})
export type PullRequestCreate = z.infer<typeof PullRequestCreateSchema>

export const PullRequestCreateResultSchema = PullRequestTargetSchema.extend({
  url: z.string().url().startsWith('https://github.com/'),
})
export type PullRequestCreateResult = z.infer<typeof PullRequestCreateResultSchema>

/** A repository file or GitHub upload embedded in pull-request Markdown. */
export const PullRequestImageUrlSchema = z
  .string()
  .url()
  .max(2048)
  .regex(
    /^https:\/\/(?:github\.com|raw\.githubusercontent\.com|private-user-images\.githubusercontent\.com)\//,
  )
export type PullRequestImageUrl = z.infer<typeof PullRequestImageUrlSchema>

export const PULL_REQUEST_IMAGE_MAX_BYTES = 10 * 1024 * 1024

export const PullRequestImageSchema = z.object({
  mediaType: z.enum([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/svg+xml',
    'image/bmp',
    'image/x-icon',
  ]),
  /** Base64-encoded image bytes. */
  data: z
    .string()
    .min(1)
    .max(Math.ceil(PULL_REQUEST_IMAGE_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((data) => data.length % 4 === 0),
})
export type PullRequestImage = z.infer<typeof PullRequestImageSchema>
