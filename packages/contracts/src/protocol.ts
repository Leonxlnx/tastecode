import { z } from 'zod'
import {
  ModelConnectionListSchema,
  ModelConnectionModelsSchema,
  ModelConnectionSchema,
} from './connections.js'
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

export const PROTOCOL_VERSION = 2

/** Bumped whenever a client and server can no longer understand each other. */
export const ErrorCode = {
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  STALE_SNAPSHOT: 'stale_snapshot',
  INTERNAL: 'internal',
} as const
export const ErrorCodeSchema = z.enum([
  ErrorCode.BAD_REQUEST,
  ErrorCode.NOT_FOUND,
  ErrorCode.PROVIDER_UNAVAILABLE,
  ErrorCode.STALE_SNAPSHOT,
  ErrorCode.INTERNAL,
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const RequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
})
export type Request = z.infer<typeof RequestSchema>

export const QueuedTurnSchema = z.object({
  id: z.string(),
  text: z.string(),
  attachments: z.array(z.string()),
  createdAt: z.number(),
})
export type QueuedTurn = z.infer<typeof QueuedTurnSchema>

export const PanicStopSessionResultSchema = z.discriminatedUnion('status', [
  z.object({ threadId: z.string(), status: z.literal('interrupted') }),
  z.object({ threadId: z.string(), status: z.literal('failed'), error: z.string().min(1) }),
])
export type PanicStopSessionResult = z.infer<typeof PanicStopSessionResultSchema>

export const PanicStopResultSchema = z.object({
  sessions: z.array(PanicStopSessionResultSchema),
})
export type PanicStopResult = z.infer<typeof PanicStopResultSchema>

export const TerminalIdSchema = z.string().min(1)
export type TerminalId = z.infer<typeof TerminalIdSchema>

export const TerminalSizeSchema = z.object({
  columns: z.number().int().min(1).max(1_000),
  rows: z.number().int().min(1).max(1_000),
})
export type TerminalSize = z.infer<typeof TerminalSizeSchema>

export const ResponseSchema = z.union([
  z.object({ id: z.string(), result: z.unknown() }),
  z.object({
    id: z.string(),
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      /** Shown to the user verbatim when present, so keep it human-readable. */
      detail: z.string().optional(),
    }),
  }),
])
export type Response = z.infer<typeof ResponseSchema>

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

const HttpUrlSchema = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'expected an HTTP or HTTPS URL')

export const McpConfigValueSchema = z.discriminatedUnion('source', [
  /** Non-secret config only. Credentials must use the reference shape below. */
  z.object({ source: z.literal('literal'), value: z.string() }),
  z.object({ source: z.literal('credential'), credentialRef: z.string().min(1) }),
])
export type McpConfigValue = z.infer<typeof McpConfigValueSchema>

export const McpTransportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    environment: z.record(z.string().min(1), McpConfigValueSchema).optional(),
  }),
  z.object({
    type: z.literal('http'),
    url: HttpUrlSchema,
    headers: z.record(z.string().min(1), McpConfigValueSchema).optional(),
  }),
])
export type McpTransport = z.infer<typeof McpTransportSchema>

export const McpServerScopeSchema = z.enum(['project', 'global'])
export type McpServerScope = z.infer<typeof McpServerScopeSchema>

export const McpAuthSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unsupported') }),
  z.object({ status: z.literal('not_required') }),
  z.object({ status: z.literal('sign_in_required'), method: z.enum(['oauth', 'bearer']) }),
  z.object({ status: z.literal('authenticated'), method: z.enum(['oauth', 'bearer']) }),
])
export type McpAuth = z.infer<typeof McpAuthSchema>

export const McpStartupStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('stopped') }),
  z.object({ state: z.literal('starting') }),
  z.object({ state: z.literal('ready') }),
  z.object({ state: z.literal('failed'), message: z.string().min(1) }),
])
export type McpStartupStatus = z.infer<typeof McpStartupStatusSchema>

export const McpToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), JsonValueSchema),
  outputSchema: z.record(z.string(), JsonValueSchema).optional(),
})
export type McpTool = z.infer<typeof McpToolSchema>

export const McpResourceSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  mimeType: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
})
export type McpResource = z.infer<typeof McpResourceSchema>

export const McpResourceTemplateSchema = z.object({
  uriTemplate: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  mimeType: z.string().min(1).optional(),
})
export type McpResourceTemplate = z.infer<typeof McpResourceTemplateSchema>

/** A project entry either hides an inherited server or defines its replacement. */
export const McpServerConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ id: z.string().min(1), enabled: z.literal(false) }),
  z.object({
    id: z.string().min(1),
    enabled: z.literal(true),
    displayName: z.string().min(1).optional(),
    transport: McpTransportSchema,
  }),
])
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

export const McpServerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  version: z.string().min(1).optional(),
  scope: McpServerScopeSchema,
  enabled: z.boolean(),
  /** Vendor-global inventory may not expose its underlying transport. */
  transport: McpTransportSchema.optional(),
  auth: McpAuthSchema,
  startup: McpStartupStatusSchema,
  tools: z.array(McpToolSchema),
  resources: z.array(McpResourceSchema),
  resourceTemplates: z.array(McpResourceTemplateSchema),
})
export type McpServer = z.infer<typeof McpServerSchema>

export const McpCapabilitiesSchema = z.object({
  inventory: z.boolean(),
  add: z.boolean(),
  update: z.boolean(),
  remove: z.boolean(),
  reload: z.boolean(),
  startOAuth: z.boolean(),
  cancelOAuth: z.boolean(),
})
export type McpCapabilities = z.infer<typeof McpCapabilitiesSchema>

export const SkillScopeSchema = z.enum(['project', 'user', 'system', 'admin'])
export type SkillScope = z.infer<typeof SkillScopeSchema>

/** Where the provider discovered the skill without exposing vendor internals. */
export const SkillSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('folder'), path: z.string().min(1) }),
  z.object({ type: z.literal('provider') }),
])
export type SkillSource = z.infer<typeof SkillSourceSchema>

export const SkillDependencyErrorSchema = z.object({
  dependency: z.string().min(1),
  message: z.string().min(1),
})
export type SkillDependencyError = z.infer<typeof SkillDependencyErrorSchema>

export const SkillSchema = z.object({
  /** Opaque provider-owned identity used by mutations. */
  id: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string(),
  source: SkillSourceSchema,
  scope: SkillScopeSchema,
  enabled: z.boolean(),
  dependencyErrors: z.array(SkillDependencyErrorSchema),
})
export type Skill = z.infer<typeof SkillSchema>

export const SkillDiscoveryErrorSchema = z.object({
  path: z.string().min(1),
  message: z.string().min(1),
})
export type SkillDiscoveryError = z.infer<typeof SkillDiscoveryErrorSchema>

export const SkillCapabilitiesSchema = z.object({
  inventory: z.boolean(),
  configure: z.boolean(),
  install: z.boolean(),
})
export type SkillCapabilities = z.infer<typeof SkillCapabilitiesSchema>

export const SearchSnippetPartSchema = z.object({
  text: z.string(),
  highlighted: z.boolean(),
})
export type SearchSnippetPart = z.infer<typeof SearchSnippetPartSchema>

export const SessionSearchResultSchema = z.object({
  projectPath: z.string(),
  projectName: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  turnId: z.string(),
  provider: ProviderIdSchema,
  createdAt: z.number(),
  snippet: z.array(SearchSnippetPartSchema).min(1),
})
export type SessionSearchResult = z.infer<typeof SessionSearchResultSchema>

export const ThreadInboxStatusSchema = z.enum([
  'starting',
  'working',
  'queued',
  'approval',
  'input',
  'failed',
  'ready',
  'idle',
])
export type ThreadInboxStatus = z.infer<typeof ThreadInboxStatusSchema>

export const ThreadLifecycleSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('active'),
    keepActive: z.boolean(),
    wokeAt: z.number().int().nonnegative().optional(),
  }),
  z.object({
    state: z.literal('settled'),
    settledAt: z.number().int().nonnegative(),
    reason: z.enum(['manual', 'inactivity', 'change_request']),
  }),
  z.object({
    state: z.literal('snoozed'),
    snoozedAt: z.number().int().nonnegative(),
    wakeAt: z.number().int().nonnegative(),
  }),
])
export type ThreadLifecycle = z.infer<typeof ThreadLifecycleSchema>

export const SidebarSettingsSchema = z.object({
  mode: z.enum(['classic', 'inbox']),
  autoSettleDays: z.number().int().min(1).max(90).nullable(),
})
export type SidebarSettings = z.infer<typeof SidebarSettingsSchema>

export const DiffLineSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('context'),
    oldLine: z.number().int().positive(),
    newLine: z.number().int().positive(),
    text: z.string(),
    noNewlineAtEnd: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('addition'),
    newLine: z.number().int().positive(),
    text: z.string(),
    noNewlineAtEnd: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('deletion'),
    oldLine: z.number().int().positive(),
    text: z.string(),
    noNewlineAtEnd: z.boolean().optional(),
  }),
])
export type DiffLine = z.infer<typeof DiffLineSchema>

export const DiffDecisionSchema = z.enum(['accept', 'reject'])
export type DiffDecision = z.infer<typeof DiffDecisionSchema>

export const DiffHunkSchema = z.object({
  id: z.string().min(1),
  header: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(DiffLineSchema),
  decision: DiffDecisionSchema.optional(),
})
export type DiffHunk = z.infer<typeof DiffHunkSchema>

export const DiffFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    binary: z.boolean(),
    hunks: z.array(DiffHunkSchema),
    decision: DiffDecisionSchema.optional(),
  })
  .superRefine((file, context) => {
    if (file.binary && file.hunks.length > 0) {
      context.addIssue({ code: 'custom', path: ['hunks'], message: 'binary files have no hunks' })
    }
    if ((file.status === 'renamed') !== (file.previousPath !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['previousPath'],
        message: 'previousPath is required only for renamed files',
      })
    }
  })
export type DiffFile = z.infer<typeof DiffFileSchema>

export const SessionDiffSchema = z.object({
  threadId: z.string(),
  version: z.string().min(1),
  files: z.array(DiffFileSchema),
})
export type SessionDiff = z.infer<typeof SessionDiffSchema>

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
  'system.panicStop': {
    params: z.object({}),
    result: PanicStopResultSchema,
  },
  'providers.list': {
    params: z.object({}),
    result: z.object({ providers: z.array(ProviderStatusSchema) }),
  },
  'connections.list': {
    params: z.object({}),
    result: ModelConnectionListSchema,
  },
  'connections.upsert': {
    params: ModelConnectionSchema.omit({
      credentialConfigured: true,
      capabilities: true,
      problem: true,
    }),
    result: z.object({ connection: ModelConnectionSchema }),
  },
  'connections.setCredential': {
    params: z.object({ connectionId: z.string().min(1), apiKey: z.string().min(1) }),
    result: z.object({ credentialConfigured: z.literal(true) }),
  },
  'connections.remove': {
    params: z.object({ connectionId: z.string().min(1) }),
    result: z.object({}),
  },
  'connections.models': {
    params: z.object({ connectionId: z.string().min(1) }),
    result: ModelConnectionModelsSchema,
  },
  'mcp.list': {
    params: z.object({ provider: ProviderIdSchema, projectPath: z.string().min(1) }),
    result: z.object({
      capabilities: McpCapabilitiesSchema,
      servers: z.array(McpServerSchema),
    }),
  },
  'mcp.add': {
    params: z.object({
      provider: ProviderIdSchema,
      projectPath: z.string().min(1),
      server: McpServerConfigSchema,
    }),
    result: z.object({}),
  },
  'mcp.update': {
    params: z.object({
      provider: ProviderIdSchema,
      projectPath: z.string().min(1),
      server: McpServerConfigSchema,
    }),
    result: z.object({}),
  },
  'mcp.remove': {
    params: z.object({
      provider: ProviderIdSchema,
      projectPath: z.string().min(1),
      serverId: z.string().min(1),
    }),
    result: z.object({}),
  },
  'mcp.reload': {
    params: z.object({ provider: ProviderIdSchema, projectPath: z.string().min(1) }),
    result: z.object({}),
  },
  'mcp.startOAuth': {
    params: z.object({
      provider: ProviderIdSchema,
      projectPath: z.string().min(1),
      serverId: z.string().min(1),
    }),
    result: z.object({ loginId: z.string().min(1), authUrl: HttpUrlSchema }),
  },
  'mcp.cancelOAuth': {
    params: z.object({
      provider: ProviderIdSchema,
      projectPath: z.string().min(1),
      serverId: z.string().min(1),
      loginId: z.string().min(1),
    }),
    result: z.object({}),
  },
  'skills.list': {
    params: z.object({ provider: ProviderIdSchema, projectPath: z.string().min(1) }),
    result: z.object({
      capabilities: SkillCapabilitiesSchema,
      skills: z.array(SkillSchema),
      errors: z.array(SkillDiscoveryErrorSchema),
    }),
  },
  'skills.setEnabled': {
    params: z.object({
      provider: ProviderIdSchema,
      projectPath: z.string().min(1),
      skillId: z.string().min(1),
      enabled: z.boolean(),
    }),
    result: z.object({ enabled: z.boolean() }),
  },
  'skills.installFromFolder': {
    params: z.object({
      provider: ProviderIdSchema,
      projectPath: z.string().min(1),
      folderPath: z.string().min(1),
    }),
    result: z.object({ skill: SkillSchema }),
  },
  'search.sessions': {
    params: z.object({
      query: z.string().trim().min(1),
      projectPath: z.string().min(1).optional(),
      provider: ProviderIdSchema.optional(),
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    result: z.object({
      results: z.array(SessionSearchResultSchema),
      nextCursor: z.string().min(1).nullable(),
    }),
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
  'workspace.branches': {
    params: z.object({ path: z.string() }),
    result: z.object({ branches: z.array(z.string()) }),
  },
  'workspace.switchBranch': {
    params: z.object({ path: z.string(), branch: z.string().min(1) }),
    result: z.object({
      branch: z.string().optional(),
      added: z.number(),
      removed: z.number(),
      dirtyFiles: z.number(),
    }),
  },
  'models.list': {
    params: z.object({ provider: ProviderIdSchema, agent: z.string().min(1).optional() }),
    result: z.object({ models: z.array(ModelSchema) }),
  },
  /**
   * Whether this provider can accept a recorded clip. Availability is account-
   * and binary-specific, so the renderer asks instead of inferring it from a mic API.
   */
  'voice.status': {
    params: z.object({ provider: ProviderIdSchema }),
    result: z.object({
      available: z.boolean(),
      reason: z
        .enum(['provider_unsupported', 'sign_in_required', 'unsupported_auth', 'codex_too_old'])
        .optional(),
    }),
  },
  /** A normalized clip. The server and Codex adapter validate the WAV again. */
  'voice.transcribe': {
    params: z.object({
      requestId: z.string().uuid(),
      provider: z.literal('codex'),
      audioBase64: z
        .string()
        .min(1)
        .max(13_981_016)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      mimeType: z.literal('audio/wav'),
      sampleRateHz: z.literal(24_000),
      durationMs: z.number().int().positive().max(120_000),
    }),
    result: z.object({ text: z.string() }),
  },
  'voice.cancel': {
    params: z.object({ requestId: z.string().uuid() }),
    result: z.object({}),
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
              /** True while the agent is actively working on a turn. */
              running: z.boolean(),
              /** Pinned chats appear in the rail's shared Pinned section. */
              pinned: z.boolean().optional(),
              /** Richer server-derived state for the inbox sidebar. */
              status: ThreadInboxStatusSchema.optional(),
              unread: z.boolean().optional(),
              /** Absent until the server supports the inbox lifecycle. */
              lifecycle: ThreadLifecycleSchema.optional(),
              closedAt: z.number().optional(),
              /** The private checkout branch, when this session is isolated. */
              worktreeBranch: z.string().optional(),
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
  /** Open the session's platform-selected shell in its actual checkout. */
  'terminal.open': {
    params: z.object({ threadId: z.string().min(1), ...TerminalSizeSchema.shape }),
    result: z.object({ terminalId: TerminalIdSchema }),
  },
  'terminal.input': {
    params: z.object({ terminalId: TerminalIdSchema, data: z.string().max(65_536) }),
    result: z.object({}),
  },
  'terminal.resize': {
    params: z.object({ terminalId: TerminalIdSchema, ...TerminalSizeSchema.shape }),
    result: z.object({}),
  },
  'terminal.close': {
    params: z.object({ terminalId: TerminalIdSchema }),
    result: z.object({}),
  },
  /** Materialize a browser clipboard image where the local agents can read it. */
  'attachments.saveImage': {
    params: z.object({
      mimeType: z.string(),
      data: z.string().max(34_952_536),
    }),
    result: z.object({ path: z.string() }),
  },
  'thread.rename': {
    params: z.object({ threadId: z.string(), title: z.string() }),
    result: z.object({}),
  },
  'thread.pin': {
    params: z.object({ threadId: z.string().min(1), pinned: z.boolean() }),
    result: z.object({}),
  },
  'thread.settle': {
    params: z.object({ threadId: z.string().min(1) }),
    result: z.object({ lifecycle: ThreadLifecycleSchema }),
  },
  'thread.unsettle': {
    params: z.object({ threadId: z.string().min(1) }),
    result: z.object({ lifecycle: ThreadLifecycleSchema }),
  },
  'thread.snooze': {
    params: z.object({
      threadId: z.string().min(1),
      wakeAt: z.number().int().nonnegative(),
    }),
    result: z.object({ lifecycle: ThreadLifecycleSchema }),
  },
  'thread.unsnooze': {
    params: z.object({ threadId: z.string().min(1) }),
    result: z.object({ lifecycle: ThreadLifecycleSchema }),
  },
  'thread.setKeepActive': {
    params: z.object({ threadId: z.string().min(1), keepActive: z.boolean() }),
    result: z.object({ lifecycle: ThreadLifecycleSchema }),
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
  'thread.diff': {
    params: z.object({ threadId: z.string() }),
    result: SessionDiffSchema,
  },
  'thread.reviewHunk': {
    params: z.object({
      threadId: z.string(),
      version: z.string().min(1),
      path: z.string().min(1),
      hunkId: z.string().min(1),
      decision: DiffDecisionSchema,
    }),
    result: z.object({ diff: SessionDiffSchema }),
  },
  'thread.reviewFile': {
    params: z.object({
      threadId: z.string(),
      version: z.string().min(1),
      path: z.string().min(1),
      decision: DiffDecisionSchema,
    }),
    result: z.object({ diff: SessionDiffSchema }),
  },
  /** Persistent token totals, with money only when the provider reports it. */
  'usage.summary': {
    params: z.object({ threadId: z.string() }),
    result: z.object({
      session: UsageSchema.omit({ contextWindow: true }),
      today: UsageSchema.omit({ contextWindow: true }),
      /** Provider-reported subscription windows. Empty when unavailable. */
      limits: z.array(
        z.object({
          label: z.string(),
          usedPercent: z.number().min(0).max(100),
          /** Unix time in milliseconds. */
          resetsAt: z.number().optional(),
        }),
      ),
    }),
  },
  'thread.start': {
    params: z
      .object({
        provider: ProviderIdSchema,
        /**
         * Which ACP agent to launch, when `provider` is `acp`. ACP is one
         * integration serving many agents, so the provider alone does not say
         * which binary to spawn.
         */
        agent: z.string().optional(),
        /** Server-owned model connection selected when `provider` is `api`. */
        connectionId: z.string().min(1).optional(),
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
      })
      .superRefine((request, context) => {
        if ((request.provider === 'api') !== Boolean(request.connectionId)) {
          context.addIssue({
            code: 'custom',
            path: ['connectionId'],
            message: 'connectionId is required only for api sessions',
          })
        }
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
    result: z.object({ undo: z.string().min(1) }),
  },
  /** Reverse the latest restore using the opaque token it returned. */
  'thread.undoRestore': {
    params: z.object({ threadId: z.string(), undo: z.string().min(1) }),
    result: z.object({}),
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
    result: z.discriminatedUnion('queued', [
      z.object({ queued: z.literal(false), turnId: z.string() }),
      z.object({ queued: z.literal(true), queuedTurn: QueuedTurnSchema }),
    ]),
  },
  /** Prompts waiting behind the turn currently in progress. */
  'thread.queue': {
    params: z.object({ threadId: z.string() }),
    result: z.object({
      items: z.array(QueuedTurnSchema),
      canSteer: z.boolean(),
    }),
  },
  'thread.deleteQueuedTurn': {
    params: z.object({ threadId: z.string(), queuedTurnId: z.string() }),
    result: z.object({}),
  },
  'thread.moveQueuedTurn': {
    params: z.object({
      threadId: z.string(),
      queuedTurnId: z.string(),
      direction: z.enum(['up', 'down']),
    }),
    result: z.object({}),
  },
  'thread.steerQueuedTurn': {
    params: z.object({ threadId: z.string(), queuedTurnId: z.string() }),
    result: z.object({}),
  },
  'thread.respondToApproval': {
    params: z.object({
      threadId: z.string(),
      approvalId: z.string(),
      decision: ApprovalDecisionSchema,
    }),
    result: z.object({}),
  },
  'thread.respondToUserInput': {
    params: z.object({
      threadId: z.string(),
      requestId: z.string().min(1),
      answers: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
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
  'sidebar.settings': {
    params: z.object({}),
    result: SidebarSettingsSchema,
  },
  'sidebar.updateSettings': {
    params: SidebarSettingsSchema.partial(),
    result: SidebarSettingsSchema,
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
  'mcp.oauth': z.object({
    provider: ProviderIdSchema,
    projectPath: z.string().min(1),
    serverId: z.string().min(1),
    loginId: z.string().min(1),
    success: z.boolean(),
    error: z.string().nullable(),
  }),
  'skills.changed': z.object({
    provider: ProviderIdSchema,
    projectPath: z.string().min(1),
  }),
  'thread.event': z.object({
    threadId: z.string(),
    event: DomainEventSchema,
  }),
  'thread.queue': z.object({
    threadId: z.string(),
    items: z.array(QueuedTurnSchema),
    canSteer: z.boolean(),
  }),
  'thread.lifecycle': z.object({
    threadId: z.string().min(1),
    lifecycle: ThreadLifecycleSchema,
  }),
  'sidebar.settings': SidebarSettingsSchema,
  'terminal.output': z.object({
    terminalId: TerminalIdSchema,
    data: z.string(),
  }),
  'terminal.exit': z.object({
    terminalId: TerminalIdSchema,
    /** Null when the platform reports termination without a numeric status. */
    exitCode: z.number().int().nullable(),
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
