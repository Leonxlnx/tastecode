import { z } from 'zod'

/**
 * The provider-agnostic model every adapter translates into.
 *
 * Thread -> Turn -> Item, borrowed from Codex's app-server because it is the
 * best-designed of the available models and maps straight onto the UI. Nothing
 * engine-specific may leak past an adapter.
 */

export const ProviderIdSchema = z.enum(['codex', 'claude-code', 'cursor', 'opencode', 'acp', 'api'])
export type ProviderId = z.infer<typeof ProviderIdSchema>

/**
 * Every distinct thing an agent produces inside a turn. The UI renders each of
 * these differently — that is the whole point of not collapsing them to text.
 */
export const ItemTypeSchema = z.enum([
  'message',
  'reasoning',
  'command',
  'file_change',
  'tool_call',
  'plan',
  'error',
  /** An event an adapter did not recognise. Rendered as raw text, never dropped. */
  'unknown',
])
export type ItemType = z.infer<typeof ItemTypeSchema>

export const ItemStatusSchema = z.enum(['started', 'completed', 'failed'])
export type ItemStatus = z.infer<typeof ItemStatusSchema>

export const ItemSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  type: ItemTypeSchema,
  status: ItemStatusSchema,
  /** Present on `message`. */
  role: z.enum(['user', 'assistant']).optional(),
  /** Accumulated text. Deltas append here. */
  text: z.string().optional(),
  /** Present on `command`: the command line and its exit code once finished. */
  command: z.string().optional(),
  exitCode: z.number().optional(),
  /** How long a command ran. Shown because a slow step is worth noticing. */
  durationMs: z.number().optional(),
  /** Present on `file_change`. */
  path: z.string().optional(),
  linesAdded: z.number().optional(),
  linesRemoved: z.number().optional(),
  createdAt: z.number(),
})
export type Item = z.infer<typeof ItemSchema>

export const TurnSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  status: z.enum(['running', 'completed', 'interrupted', 'failed']),
  createdAt: z.number(),
})
export type Turn = z.infer<typeof TurnSchema>

export const ThreadSchema = z
  .object({
    id: z.string(),
    provider: ProviderIdSchema,
    /** Selects a server-owned model connection for the Harness API runtime. */
    connectionId: z.string().min(1).optional(),
    /** Absolute path to the workspace this thread operates on. */
    workspacePath: z.string(),
    title: z.string().optional(),
    createdAt: z.number(),
  })
  .superRefine((thread, context) => {
    if ((thread.provider === 'api') !== Boolean(thread.connectionId)) {
      context.addIssue({
        code: 'custom',
        path: ['connectionId'],
        message: 'connectionId is required only for api threads',
      })
    }
  })
export type Thread = z.infer<typeof ThreadSchema>

/**
 * What an adapter emits. The server persists these to the event log and pushes
 * them to clients; adapters never talk to the UI directly.
 */
/**
 * The agent asking permission before it does something.
 *
 * This is the highest-privilege moment in the app: answering yes authorises
 * arbitrary execution or a write to disk. Everything about how it is shown and
 * answered is deliberate.
 */
export const ApprovalRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(['command', 'file_change', 'permissions']),
  /** Why the agent says it needs this. Shown verbatim; it is their words. */
  reason: z.string().optional(),
  /** Present on `command`. */
  command: z.string().optional(),
  cwd: z.string().optional(),
  /** Present on `file_change` and `permissions`. */
  path: z.string().optional(),
  createdAt: z.number(),
})
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>

export const ApprovalDecisionSchema = z.enum(['approve', 'approve-session', 'deny', 'abort'])
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>

export const ApprovalReviewSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  status: z.enum(['in_progress', 'approved', 'denied', 'timed_out', 'aborted']),
  /** A provider-neutral description of the access being reviewed. */
  description: z.string(),
  rationale: z.string().optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
})
export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>

export const UserInputOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
})
export type UserInputOption = z.infer<typeof UserInputOptionSchema>

export const UserInputQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  allowOther: z.boolean(),
  secret: z.boolean(),
  options: z.array(UserInputOptionSchema).nullable(),
})
export type UserInputQuestion = z.infer<typeof UserInputQuestionSchema>

/** A provider-neutral question set that blocks the current agent turn. */
export const UserInputRequestSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  questions: z.array(UserInputQuestionSchema).min(1),
  autoResolutionMs: z.number().int().min(60_000).max(240_000).nullable(),
  createdAt: z.number(),
})
export type UserInputRequest = z.infer<typeof UserInputRequestSchema>

/** A step in the agent's own plan for the current turn. */
export const PlanStepSchema = z.object({
  text: z.string(),
  status: z.enum(['pending', 'running', 'done']),
})
export type PlanStep = z.infer<typeof PlanStepSchema>

export const UsageSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  /** Actual cost reported by the provider. Absent when it would be an estimate. */
  costUsd: z.number().nonnegative().optional(),
  contextWindow: z.number().optional(),
})
export type Usage = z.infer<typeof UsageSchema>

export const DomainEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread: ThreadSchema }),
  z.object({ type: z.literal('turn.started'), turn: TurnSchema }),
  z.object({ type: z.literal('item.started'), item: ItemSchema }),
  z.object({
    type: z.literal('item.delta'),
    turnId: z.string(),
    itemId: z.string(),
    textDelta: z.string(),
  }),
  z.object({ type: z.literal('item.completed'), item: ItemSchema }),
  z.object({
    type: z.literal('turn.completed'),
    turnId: z.string(),
    status: z.enum(['completed', 'interrupted', 'failed']),
  }),
  z.object({ type: z.literal('thread.error'), threadId: z.string(), message: z.string() }),
  /** The agent's plan for this turn, replaced wholesale each time it changes. */
  z.object({
    type: z.literal('plan.updated'),
    turnId: z.string(),
    steps: z.array(PlanStepSchema),
  }),
  /** Token spend so far. Surfaced live rather than at the end of a turn. */
  z.object({ type: z.literal('usage.updated'), usage: UsageSchema }),
  /**
   * Everything this turn changed, as one unified diff. Kept separate from the
   * per-file items because "what did it do to my repo" is a different question
   * from "what did it do next", and the answer must not be assembled by hand.
   */
  z.object({ type: z.literal('diff.updated'), turnId: z.string(), diff: z.string() }),
  z.object({ type: z.literal('approval.requested'), request: ApprovalRequestSchema }),
  /** Resolved — by the user, or because the turn ended without an answer. */
  z.object({ type: z.literal('approval.resolved'), id: z.string() }),
  z.object({ type: z.literal('user_input.requested'), request: UserInputRequestSchema }),
  z.object({ type: z.literal('user_input.resolved'), id: z.string() }),
  z.object({ type: z.literal('approval.review.started'), review: ApprovalReviewSchema }),
  z.object({ type: z.literal('approval.review.completed'), review: ApprovalReviewSchema }),
])
export type DomainEvent = z.infer<typeof DomainEventSchema>

/**
 * What an engine can actually do. The UI reads this and hides what is
 * unavailable rather than showing a button that fails — capability negotiation
 * is the difference between a wrapper that feels solid and one that lies.
 */
export const CapabilitiesSchema = z.object({
  steer: z.boolean(),
  fork: z.boolean(),
  interrupt: z.boolean(),
  reasoningItems: z.boolean(),
  approvals: z.boolean(),
  /** Can pause a turn for structured questions and resume it with the user's answers. */
  userInput: z.boolean().optional(),
  /** Can route elevated approval requests through an automatic risk reviewer. */
  autoReview: z.boolean().optional(),
  images: z.boolean(),
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>

/**
 * A model the user can pick, as reported by the provider itself. We never keep
 * a hardcoded list — vendors ship new models constantly and a stale dropdown is
 * worse than no dropdown.
 */
export const ModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean(),
  /** e.g. low / medium / high. Empty when the model has no effort setting. */
  reasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string().optional(),
  /** Provider-advertised routing tiers, such as Codex's priority/Fast tier. */
  serviceTiers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
      }),
    )
    .default([]),
  defaultServiceTier: z.string().nullable().optional(),
})
export type Model = z.infer<typeof ModelSchema>

/**
 * How much the agent may do without asking. Mapped per adapter onto whatever
 * the engine calls it — this is the user-facing concept, and it is the single
 * most consequential setting in the app, so it is never hidden in a menu.
 */
export const ApprovalModeSchema = z.enum(['ask', 'auto', 'auto-review', 'full'])
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>

/**
 * Who the user is signed in as with a given provider.
 *
 * We learn this by asking the provider's own binary. We never read its
 * credential files — see rules/security.md.
 */
export const AccountSchema = z.object({
  signedIn: z.boolean(),
  email: z.string().optional(),
  /** Vendor's own plan name: plus, pro, team, business, enterprise, api-key… */
  plan: z.string().optional(),
})
export type Account = z.infer<typeof AccountSchema>

export const ProviderStatusSchema = z.object({
  id: ProviderIdSchema,
  displayName: z.string(),
  installed: z.boolean(),
  /** Version string reported by the vendor binary, when we could read one. */
  version: z.string().optional(),
  /**
   * We ask the vendor binary; we never inspect its credential files.
   * `unknown` means the binary could not tell us.
   */
  auth: z.enum(['authenticated', 'unauthenticated', 'unknown']),
  capabilities: CapabilitiesSchema.optional(),
  /** Why it is unusable, in language we can show the user directly. */
  problem: z.string().optional(),
})
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>
