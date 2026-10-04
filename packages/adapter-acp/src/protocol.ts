import { z } from 'zod'
import { AcpTurnTokenUsageSchema } from './usage.js'

/**
 * The Agent Client Protocol, as agents actually speak it.
 *
 * These decoders follow captured frames from `gemini --experimental-acp`.
 * Optional fields keep independent ACP implementations interoperable while
 * every frame is still decoded before it reaches the adapter.
 */

export const PROTOCOL_VERSION = 1

export const ContentBlockSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
  uri: z.string().optional(),
})

export const InitializeResultSchema = z.object({
  protocolVersion: z.number().optional(),
  agentInfo: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
  agentCapabilities: z
    .object({
      loadSession: z.boolean().optional(),
      promptCapabilities: z
        .object({
          image: z.boolean().optional(),
          audio: z.boolean().optional(),
          embeddedContext: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  authMethods: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
      }),
    )
    .optional(),
})

export const NewSessionResultSchema = z.object({
  sessionId: z.string().optional(),
  modes: z
    .object({
      currentModeId: z.string().optional(),
      availableModes: z
        .array(z.object({ id: z.string().optional(), name: z.string().optional() }))
        .optional(),
    })
    .optional(),
  configOptions: z
    .array(
      z.object({
        id: z.string().optional(),
        currentValue: z.string().optional(),
        options: z
          .array(
            z.object({
              value: z.string().optional(),
              name: z.string().optional(),
              description: z.string().nullable().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
})

export const StopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
])

export const PromptResultSchema = z.object({
  stopReason: StopReasonSchema.optional(),
  usage: AcpTurnTokenUsageSchema.nullable().optional(),
})

export const ToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
])

export const ToolCallStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed'])

export const ToolCallContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('content'), content: ContentBlockSchema.optional() }),
  z.object({
    type: z.literal('diff'),
    path: z.string().optional(),
    oldText: z.string().nullable().optional(),
    newText: z.string().optional(),
  }),
  z.object({ type: z.literal('terminal'), terminalId: z.string().optional() }),
])

const ToolCallFields = {
  toolCallId: z.string().optional(),
  title: z.string().optional(),
  kind: ToolKindSchema.optional(),
  status: ToolCallStatusSchema.optional(),
  content: z.array(ToolCallContentSchema).optional(),
  locations: z
    .array(z.object({ path: z.string().optional(), line: z.number().optional() }))
    .optional(),
  rawInput: z.record(z.string(), z.json()).optional(),
}

export const ToolCallFieldsSchema = z.object(ToolCallFields)

export const SessionUpdateSchema = z.object({
  ...ToolCallFields,
  sessionUpdate: z.string().optional(),
  content: z.union([ContentBlockSchema, z.array(ToolCallContentSchema)]).optional(),
  entries: z
    .array(
      z.object({
        content: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
      }),
    )
    .optional(),
  availableCommands: z
    .array(z.object({ name: z.string().optional(), description: z.string().optional() }))
    .optional(),
  currentModeId: z.string().optional(),
  used: z.number().optional(),
  size: z.number().optional(),
  cost: z
    .object({ amount: z.number().optional(), currency: z.string().optional() })
    .nullable()
    .optional(),
})

export const SessionNotificationSchema = z.object({
  sessionId: z.string().optional(),
  update: SessionUpdateSchema.optional(),
})

export const PermissionOptionKindSchema = z.enum([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
])

export const RequestPermissionParamsSchema = z.object({
  sessionId: z.string().optional(),
  toolCall: ToolCallFieldsSchema.optional(),
  options: z
    .array(
      z.object({
        optionId: z.string().optional(),
        name: z.string().optional(),
        kind: PermissionOptionKindSchema.optional(),
      }),
    )
    .optional(),
})

export type ContentBlock = z.infer<typeof ContentBlockSchema>
export type InitializeResult = z.infer<typeof InitializeResultSchema>
export type NewSessionResult = z.infer<typeof NewSessionResultSchema>
export type StopReason = z.infer<typeof StopReasonSchema>
export type PromptResult = z.infer<typeof PromptResultSchema>
export type ToolKind = z.infer<typeof ToolKindSchema>
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>
export type ToolCallContent = z.infer<typeof ToolCallContentSchema>
export type ToolCallFields = z.infer<typeof ToolCallFieldsSchema>
export type SessionUpdate = z.infer<typeof SessionUpdateSchema>
export type SessionNotification = z.infer<typeof SessionNotificationSchema>
export type PermissionOptionKind = z.infer<typeof PermissionOptionKindSchema>
export type RequestPermissionParams = z.infer<typeof RequestPermissionParamsSchema>
