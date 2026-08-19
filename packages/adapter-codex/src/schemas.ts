import { JsonRpcValueSchema } from '@harness/proc'
import { z } from 'zod'
import { CodexThreadItemSchema } from './map-item.js'

const nullableString = z.string().nullable()
const nullableNumber = z.number().nullable()

const OtherAccountSchema = z
  .object({ type: z.string() })
  .refine(({ type }) => type !== 'apiKey' && type !== 'chatgpt')
  .transform(() => ({ type: 'other' as const }))

export const AccountResponseSchema = z.object({
  account: z
    .union([
      z.object({ type: z.literal('apiKey') }),
      z.object({ type: z.literal('chatgpt'), email: nullableString, planType: z.string() }),
      OtherAccountSchema,
    ])
    .nullable(),
})

const RateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: nullableNumber,
  resetsAt: nullableNumber,
})

const CreditsSnapshotSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: nullableString,
})

export const CodexRateLimitSnapshotSchema = z.object({
  limitId: nullableString,
  limitName: nullableString,
  primary: RateLimitWindowSchema.nullable(),
  secondary: RateLimitWindowSchema.nullable(),
  credits: CreditsSnapshotSchema.nullable(),
  individualLimit: JsonRpcValueSchema.nullable(),
  planType: nullableString,
  rateLimitReachedType: nullableString,
})

export const CodexRateLimitResponseSchema = z.object({
  rateLimits: CodexRateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), CodexRateLimitSnapshotSchema.optional()).nullable(),
  rateLimitResetCredits: z
    .object({
      availableCount: z.union([z.number(), z.string()]),
      credits: z.array(JsonRpcValueSchema).nullable().optional(),
    })
    .nullable(),
})

export type CodexRateLimitSnapshot = z.infer<typeof CodexRateLimitSnapshotSchema>
export type CodexRateLimitResponse = z.infer<typeof CodexRateLimitResponseSchema>

export const LoginAccountResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('apiKey') }),
  z.object({ type: z.literal('chatgpt'), loginId: z.string(), authUrl: z.string() }),
  z.object({
    type: z.literal('chatgptDeviceCode'),
    loginId: z.string(),
    verificationUrl: z.string(),
    userCode: z.string(),
  }),
  z.object({ type: z.literal('chatgptAuthTokens') }),
])

const ModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().nullish(),
  hidden: z.boolean(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
  defaultReasoningEffort: z.string().nullable(),
  serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  defaultServiceTier: z.string().nullable(),
  isDefault: z.boolean(),
})

export const ModelListResponseSchema = z.object({
  data: z.array(ModelSchema),
  nextCursor: nullableString,
})

export const JsonObjectSchema = z.record(z.string(), JsonRpcValueSchema)

export const McpServerStatusSchema = z.object({
  name: z.string(),
  serverInfo: z
    .object({
      name: z.string(),
      title: nullableString,
      version: z.string(),
      description: nullableString,
    })
    .nullable(),
  tools: z.record(
    z.string(),
    z
      .object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        inputSchema: JsonRpcValueSchema,
        outputSchema: JsonRpcValueSchema.optional(),
      })
      .optional(),
  ),
  resources: z.array(
    z.object({
      uri: z.string(),
      name: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      size: z.number().optional(),
    }),
  ),
  resourceTemplates: z.array(
    z.object({
      uriTemplate: z.string(),
      name: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
    }),
  ),
  authStatus: z.enum(['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth']),
})

export type ParsedMcpServerStatus = z.infer<typeof McpServerStatusSchema>

export const ListMcpServerStatusResponseSchema = z.object({
  data: z.array(McpServerStatusSchema),
  nextCursor: nullableString,
})

const SkillToolDependencySchema = z.object({
  type: z.string(),
  value: z.string(),
})

export const SkillsListResponseSchema = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      skills: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          interface: z.object({ displayName: z.string().optional() }).optional(),
          dependencies: z.object({ tools: z.array(SkillToolDependencySchema) }).optional(),
          path: z.string(),
          scope: z.enum(['repo', 'user', 'system', 'admin']),
          enabled: z.boolean(),
        }),
      ),
      errors: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  ),
})

export type ParsedSkillsListResponse = z.infer<typeof SkillsListResponseSchema>

export const SkillsConfigWriteResponseSchema = z.object({ effectiveEnabled: z.boolean() })
export const McpServerOauthLoginResponseSchema = z.object({ authorizationUrl: z.string() })

const ThreadIdentitySchema = z.object({
  id: z.string(),
  createdAt: z.number().optional(),
  cwd: z.string().nullish(),
})

export const ThreadStartResponseSchema = z.object({
  thread: ThreadIdentitySchema,
  model: z.string(),
})

export const ThreadResumeResponseSchema = ThreadStartResponseSchema.extend({
  thread: ThreadIdentitySchema.extend({ createdAt: z.number() }),
})

export const TurnStartResponseSchema = z.object({ turn: z.object({ id: z.string() }) })

const UserInputOptionSchema = z.object({ label: z.string(), description: z.string() })

export const ToolRequestUserInputParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      isOther: z.boolean(),
      isSecret: z.boolean(),
      options: z.array(UserInputOptionSchema).nullable(),
    }),
  ),
  autoResolutionMs: nullableNumber,
})

export type ToolRequestUserInputParams = z.infer<typeof ToolRequestUserInputParamsSchema>

const AdditionalNetworkPermissionsSchema = z.object({ enabled: z.boolean().nullable() })
const AdditionalFileSystemPermissionsSchema = z.object({
  read: z.array(z.string()).nullable(),
  write: z.array(z.string()).nullable(),
  globScanMaxDepth: z.number().optional(),
  entries: z.array(JsonRpcValueSchema).optional(),
})

export const RequestPermissionProfileSchema = z.object({
  network: AdditionalNetworkPermissionsSchema.nullable(),
  fileSystem: AdditionalFileSystemPermissionsSchema.nullable(),
})

export type RequestPermissionProfile = z.infer<typeof RequestPermissionProfileSchema>

export const PermissionsRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  environmentId: nullableString,
  startedAtMs: z.number(),
  cwd: z.string(),
  reason: nullableString,
  permissions: RequestPermissionProfileSchema,
})

export type PermissionsRequestApprovalParams = z.infer<
  typeof PermissionsRequestApprovalParamsSchema
>

export const ApprovalParamsSchema = z.object({
  itemId: z.string().optional(),
  approvalId: nullableString.optional(),
  reason: nullableString.optional(),
  command: nullableString.optional(),
  cwd: nullableString.optional(),
  grantRoot: nullableString.optional(),
})

export type ApprovalParams = z.infer<typeof ApprovalParamsSchema>

const GuardianActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), command: z.string() }),
  z.object({ type: z.literal('execve'), program: z.string(), argv: z.array(z.string()) }),
  z.object({ type: z.literal('applyPatch'), files: z.array(z.string()) }),
  z.object({ type: z.literal('networkAccess'), target: z.string() }),
  z.object({
    type: z.literal('mcpToolCall'),
    server: z.string(),
    toolName: z.string(),
    toolTitle: nullableString,
  }),
  z.object({ type: z.literal('requestPermissions'), reason: nullableString }),
])

const GuardianReviewSchema = z.object({
  status: z.enum(['inProgress', 'approved', 'denied', 'timedOut', 'aborted']),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
  rationale: nullableString,
})

const GuardianReviewBaseSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  startedAtMs: z.number(),
  reviewId: z.string(),
  review: GuardianReviewSchema,
  action: GuardianActionSchema,
})

export const GuardianReviewStartedSchema = GuardianReviewBaseSchema
export const GuardianReviewCompletedSchema = GuardianReviewBaseSchema.extend({
  completedAtMs: z.number(),
})

export type GuardianReviewAction = z.infer<typeof GuardianActionSchema>
export type GuardianReviewNotification =
  z.infer<typeof GuardianReviewStartedSchema> | z.infer<typeof GuardianReviewCompletedSchema>

export const ThreadStartedNotificationSchema = z.object({ thread: ThreadIdentitySchema })
export const TurnStartedNotificationSchema = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string() }),
})
export const TurnCompletedNotificationSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  }),
})
export const ItemStartedNotificationSchema = z.object({
  item: CodexThreadItemSchema,
  threadId: z.string(),
  turnId: z.string(),
  startedAtMs: z.number(),
})
export const ItemCompletedNotificationSchema = z.object({
  item: CodexThreadItemSchema,
  threadId: z.string(),
  turnId: z.string(),
  completedAtMs: z.number(),
})
export const ItemDeltaNotificationSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
})
export const CommandOutputDeltaNotificationSchema = ItemDeltaNotificationSchema.extend({
  delta: z.string().optional(),
  deltaBase64: z.string().optional(),
})
export const TurnPlanUpdatedNotificationSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  explanation: nullableString,
  plan: z.array(
    z.object({
      step: z.string(),
      status: z.enum(['pending', 'inProgress', 'completed']),
    }),
  ),
})
export const TurnDiffUpdatedNotificationSchema = z.object({
  turnId: z.string(),
  diff: z.string(),
})

const TokenUsageBreakdownSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
})

export const ThreadTokenUsageUpdatedNotificationSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  tokenUsage: z.object({
    total: TokenUsageBreakdownSchema,
    last: TokenUsageBreakdownSchema,
    modelContextWindow: nullableNumber,
  }),
})

export type ThreadTokenUsageUpdatedNotification = z.infer<
  typeof ThreadTokenUsageUpdatedNotificationSchema
>

export const AccountLoginCompletedNotificationSchema = z.object({
  loginId: nullableString,
  success: z.boolean(),
  error: nullableString,
})
export const WarningNotificationSchema = z.object({
  threadId: nullableString,
  message: z.string(),
})
export type WarningNotification = z.infer<typeof WarningNotificationSchema>

export const ErrorNotificationSchema = z.object({
  error: z.object({ message: z.string() }),
  willRetry: z.boolean(),
  threadId: z.string(),
  turnId: z.string(),
})
export type ErrorNotification = z.infer<typeof ErrorNotificationSchema>

export const McpServerStatusUpdatedNotificationSchema = z.object({
  threadId: nullableString,
  name: z.string(),
  status: z.enum(['starting', 'ready', 'failed', 'cancelled']),
  error: nullableString,
  failureReason: z.literal('reauthenticationRequired').nullable(),
})
export type McpServerStatusUpdatedNotification = z.infer<
  typeof McpServerStatusUpdatedNotificationSchema
>

export const McpServerOauthLoginCompletedNotificationSchema = z.object({
  name: z.string(),
  threadId: nullableString,
  success: z.boolean(),
  error: z.string().optional(),
})

export const VoiceTranscriptResponseSchema = z.object({
  text: z.string(),
})

export const VoiceErrorResponseSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
  message: z.string().optional(),
})
