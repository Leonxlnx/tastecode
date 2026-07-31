import { z } from 'zod'
import {
  AccountSchema,
  ApprovalDecisionSchema,
  ApprovalModeSchema,
  DomainEventSchema,
  ModelSchema,
  ProviderIdSchema,
  ProviderStatusSchema,
  UsageSchema,
} from './domain.js'

/**
 * The wire protocol between any client (desktop renderer, web, later mobile)
 * and the local core server.
 *
 * Two shapes only:
 *   request/response — client asks, server answers
 *   push             — server tells, unprompted
 *
 * Every payload is validated at the transport boundary in both directions. That
 * validation is what keeps three client surfaces from silently drifting apart.
 */

export const PROTOCOL_VERSION = 1

/** Bumped whenever a client and server can no longer understand each other. */
export const ErrorCode = {
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  INTERNAL: 'internal',
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const RequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
})
export type Request = z.infer<typeof RequestSchema>

export const ResponseSchema = z.union([
  z.object({ id: z.string(), result: z.unknown() }),
  z.object({
    id: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      /** Shown to the user verbatim when present, so keep it human-readable. */
      detail: z.string().optional(),
    }),
  }),
])
export type Response = z.infer<typeof ResponseSchema>

/**
 * Method table. Adding a method means adding it here first — this object is the
 * single source of truth that the server routes against and the client calls.
 */
export const methods = {
  'system.info': {
    params: z.object({}),
    result: z.object({
      serverVersion: z.string(),
      protocolVersion: z.number(),
      platform: z.enum(['win32', 'darwin', 'linux']),
    }),
  },
  'providers.list': {
    params: z.object({}),
    result: z.object({ providers: z.array(ProviderStatusSchema) }),
  },
  'auth.status': {
    params: z.object({ provider: ProviderIdSchema }),
    result: AccountSchema,
  },
  /**
   * Starts the vendor's real OAuth flow and returns the URL to open. The user
   * signs in on the vendor's own site; completion arrives on `auth.event`.
   */
  'auth.startLogin': {
    params: z.object({ provider: ProviderIdSchema }),
    result: z.object({ loginId: z.string(), authUrl: z.string() }),
  },
  'auth.cancelLogin': {
    params: z.object({ provider: ProviderIdSchema, loginId: z.string() }),
    result: z.object({}),
  },
  'auth.useApiKey': {
    params: z.object({ provider: ProviderIdSchema, apiKey: z.string() }),
    result: AccountSchema,
  },
  'auth.signOut': {
    params: z.object({ provider: ProviderIdSchema }),
    result: z.object({}),
  },
  'workspace.info': {
    params: z.object({ path: z.string() }),
    result: z.object({
      branch: z.string().optional(),
      added: z.number(),
      removed: z.number(),
      dirtyFiles: z.number(),
    }),
  },
  'models.list': {
    params: z.object({ provider: ProviderIdSchema }),
    result: z.object({ models: z.array(ModelSchema) }),
  },
  /**
   * Agents reachable over ACP, and whether each one is actually on this
   * machine. The list is the server's to answer because only it can look.
   */
  'acp.agents': {
    params: z.object({}),
    result: z.object({
      agents: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          installed: z.boolean(),
          /** True when we captured and read this agent's frames ourselves. */
          verified: z.boolean(),
          install: z.string().optional(),
        }),
      ),
    }),
  },
  /**
   * Projects and sessions the server knows about. These replace what the
   * renderer used to keep in localStorage, where a reload could destroy it.
   */
  'projects.list': {
    params: z.object({}),
    result: z.object({
      projects: z.array(
        z.object({
          path: z.string(),
          name: z.string(),
          pinned: z.boolean(),
          createdAt: z.number(),
          sessions: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              provider: ProviderIdSchema,
              agent: z.string().optional(),
              createdAt: z.number(),
              /** True while a process is alive for it, not merely on record. */
              running: z.boolean(),
              closedAt: z.number().optional(),
            }),
          ),
        }),
      ),
    }),
  },
  'projects.add': {
    params: z.object({ path: z.string(), name: z.string().optional() }),
    result: z.object({
      path: z.string(),
      name: z.string(),
      pinned: z.boolean(),
      createdAt: z.number(),
    }),
  },
  'projects.pin': {
    params: z.object({ path: z.string(), pinned: z.boolean() }),
    result: z.object({}),
  },
  'projects.rename': {
    params: z.object({ path: z.string(), name: z.string() }),
    result: z.object({}),
  },
  'projects.remove': {
    params: z.object({ path: z.string() }),
    result: z.object({}),
  },
  'thread.rename': {
    params: z.object({ threadId: z.string(), title: z.string() }),
    result: z.object({}),
  },
  'thread.delete': {
    params: z.object({ threadId: z.string() }),
    result: z.object({}),
  },
  /**
   * Everything that has happened in a thread, so reopening it shows the
   * conversation rather than an empty pane. `afterSeq` asks only for the tail,
   * which is what a client that fell behind needs.
   */
  'thread.history': {
    params: z.object({ threadId: z.string(), afterSeq: z.number().optional() }),
    result: z.object({
      events: z.array(z.object({ seq: z.number(), event: DomainEventSchema })),
      running: z.boolean(),
    }),
  },
  /** Persistent token totals, with money only when the provider reports it. */
  'usage.summary': {
    params: z.object({ threadId: z.string() }),
    result: z.object({
      session: UsageSchema.omit({ contextWindow: true }),
      today: UsageSchema.omit({ contextWindow: true }),
    }),
  },
  'thread.start': {
    params: z.object({
      provider: ProviderIdSchema,
      /**
       * Which ACP agent to launch, when `provider` is `acp`. ACP is one
       * integration serving many agents, so the provider alone does not say
       * which binary to spawn.
       */
      agent: z.string().optional(),
      workspacePath: z.string(),
      model: z.string().optional(),
      serviceTier: z.string().optional(),
      effort: z.string().optional(),
      approval: ApprovalModeSchema.optional(),
      /**
       * Give this session a private git worktree instead of the project folder
       * itself. Two agents in one directory overwrite each other, and the
       * second to write wins silently.
       */
      isolate: z.boolean().optional(),
    }),
    result: z.object({ threadId: z.string() }),
  },
  /**
   * Points this session can be returned to. One is taken before every turn
   * that could write, so going back is possible without having planned for it.
   */
  'thread.checkpoints': {
    params: z.object({ threadId: z.string() }),
    result: z.object({
      checkpoints: z.array(
        z.object({
          id: z.number(),
          seq: z.number(),
          label: z.string(),
          createdAt: z.number(),
        }),
      ),
    }),
  },
  /** What the agent has changed since a checkpoint, so a restore is informed. */
  'thread.changedSince': {
    params: z.object({ threadId: z.string(), checkpointId: z.number() }),
    result: z.object({ files: z.array(z.string()) }),
  },
  /**
   * Put files and conversation back to a checkpoint. Whatever is replaced is
   * itself saved first, so no restore reaches a state nobody can get back to.
   */
  'thread.restore': {
    params: z.object({ threadId: z.string(), checkpointId: z.number() }),
    result: z.object({ undo: z.string() }),
  },
  /** Whether a session's private checkout holds work nobody has committed. */
  'thread.unsavedWork': {
    params: z.object({ threadId: z.string() }),
    result: z.object({ isolated: z.boolean(), uncommitted: z.boolean() }),
  },
  /**
   * Remove a session's private checkout. Fails when it holds uncommitted work
   * unless `force`, which is the user saying to discard it.
   */
  'thread.discardWorktree': {
    params: z.object({ threadId: z.string(), force: z.boolean().optional() }),
    result: z.object({}),
  },
  'thread.sendTurn': {
    params: z.object({
      threadId: z.string(),
      text: z.string(),
      /** Absolute paths the user attached. The agent reads them itself. */
      attachments: z.array(z.string()).optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      serviceTier: z.string().optional(),
    }),
    result: z.object({ turnId: z.string() }),
  },
  'thread.respondToApproval': {
    params: z.object({
      threadId: z.string(),
      approvalId: z.string(),
      decision: ApprovalDecisionSchema,
    }),
    result: z.object({}),
  },
  'thread.interrupt': {
    params: z.object({ threadId: z.string() }),
    result: z.object({}),
  },
  'thread.close': {
    params: z.object({ threadId: z.string() }),
    result: z.object({}),
  },
} as const

export type MethodName = keyof typeof methods
export type ParamsOf<M extends MethodName> = z.infer<(typeof methods)[M]['params']>
export type ResultOf<M extends MethodName> = z.infer<(typeof methods)[M]['result']>

// ---------------------------------------------------------------------------
// Pushes
// ---------------------------------------------------------------------------

/**
 * `sequence` is monotonic per connection. A client that sees a gap knows it
 * missed something and can resync, instead of silently diverging from the
 * server — which is the failure mode that is impossible to debug later.
 */
export const PushSchema = z.object({
  channel: z.string(),
  sequence: z.number(),
  data: z.unknown(),
})
export type Push = z.infer<typeof PushSchema>

export const channels = {
  'server.welcome': z.object({
    serverVersion: z.string(),
    protocolVersion: z.number(),
  }),
  'auth.event': z.object({
    provider: ProviderIdSchema,
    loginId: z.string().nullable(),
    success: z.boolean(),
    error: z.string().nullable(),
  }),
  'thread.event': z.object({
    threadId: z.string(),
    event: DomainEventSchema,
  }),
} as const

export type ChannelName = keyof typeof channels
export type DataOf<C extends ChannelName> = z.infer<(typeof channels)[C]>

// ---------------------------------------------------------------------------
// Decode diagnostics
// ---------------------------------------------------------------------------

/**
 * What a failed boundary decode produces. Structured on purpose: "invalid
 * message" in a log tells you nothing at 2am.
 */
export type DecodeDiagnostic = {
  direction: 'inbound' | 'outbound'
  what: string
  reason: string
  path?: string
}
