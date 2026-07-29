import { z } from 'zod'
import {
  AccountSchema,
  ApprovalDecisionSchema,
  ApprovalModeSchema,
  DomainEventSchema,
  ModelSchema,
  ProviderIdSchema,
  ProviderStatusSchema,
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
  'thread.start': {
    params: z.object({
      provider: ProviderIdSchema,
      workspacePath: z.string(),
      model: z.string().optional(),
      effort: z.string().optional(),
      approval: ApprovalModeSchema.optional(),
    }),
    result: z.object({ threadId: z.string() }),
  },
  'thread.sendTurn': {
    params: z.object({
      threadId: z.string(),
      text: z.string(),
      /** Absolute paths the user attached. The agent reads them itself. */
      attachments: z.array(z.string()).optional(),
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
