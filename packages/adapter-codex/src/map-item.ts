import path from 'node:path'
import type { Item, ItemStatus } from '@harness/contracts'
import { z } from 'zod'

const ItemEnvelopeSchema = z.object({ type: z.string(), id: z.string().optional() })
const UserMessageSchema = z.object({
  type: z.literal('userMessage'),
  id: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})
const AgentMessageSchema = z.object({
  type: z.literal('agentMessage'),
  id: z.string().optional(),
  text: z.string(),
  phase: z.enum(['commentary', 'final_answer']).nullable(),
})
const ReasoningSchema = z.object({
  type: z.literal('reasoning'),
  id: z.string().optional(),
  summary: z.array(z.string()),
  content: z.array(z.string()),
})
const PlanSchema = z.object({
  type: z.literal('plan'),
  id: z.string().optional(),
  text: z.string(),
})
const CommandSchema = z.object({
  type: z.literal('commandExecution'),
  id: z.string().optional(),
  command: z.string(),
  aggregatedOutput: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
})
const FileChangeSchema = z.object({
  type: z.literal('fileChange'),
  id: z.string().optional(),
  changes: z.array(z.object({ path: z.string() })),
})
const McpToolCallSchema = z.object({
  type: z.literal('mcpToolCall'),
  id: z.string().optional(),
  server: z.string(),
  tool: z.string(),
  durationMs: z.number().nullable(),
})
const DynamicToolCallSchema = z.object({
  type: z.literal('dynamicToolCall'),
  id: z.string().optional(),
  tool: z.string(),
  durationMs: z.number().nullable(),
})
const CollabAgentSchema = z.object({
  type: z.literal('collabAgentToolCall'),
  id: z.string().optional(),
  tool: z.enum(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent']),
  status: z.enum(['inProgress', 'completed', 'failed']),
  receiverThreadIds: z.array(z.string()),
  agentsStates: z.record(
    z.string(),
    z
      .object({
        status: z.enum([
          'pendingInit',
          'running',
          'interrupted',
          'completed',
          'errored',
          'shutdown',
          'notFound',
        ]),
      })
      .optional(),
  ),
})
const SubAgentActivitySchema = z.object({
  type: z.literal('subAgentActivity'),
  id: z.string().optional(),
  kind: z.enum(['started', 'interacted', 'interrupted']),
})
const ImageViewSchema = z.object({
  type: z.literal('imageView'),
  id: z.string().optional(),
  path: z.string(),
})
const SleepSchema = z.object({
  type: z.literal('sleep'),
  id: z.string().optional(),
  durationMs: z.number(),
})
const HookPromptSchema = z.object({ type: z.literal('hookPrompt'), id: z.string().optional() })
const WebSearchSchema = z.object({ type: z.literal('webSearch'), id: z.string().optional() })
const ImageGenerationSchema = z.object({
  type: z.literal('imageGeneration'),
  id: z.string().optional(),
})
const EnteredReviewModeSchema = z.object({
  type: z.literal('enteredReviewMode'),
  id: z.string().optional(),
})
const ExitedReviewModeSchema = z.object({
  type: z.literal('exitedReviewMode'),
  id: z.string().optional(),
})
const ContextCompactionSchema = z.object({
  type: z.literal('contextCompaction'),
  id: z.string().optional(),
})

const KnownThreadItemSchema = z.discriminatedUnion('type', [
  UserMessageSchema,
  HookPromptSchema,
  AgentMessageSchema,
  ReasoningSchema,
  PlanSchema,
  CommandSchema,
  FileChangeSchema,
  McpToolCallSchema,
  DynamicToolCallSchema,
  CollabAgentSchema,
  SubAgentActivitySchema,
  WebSearchSchema,
  ImageViewSchema,
  SleepSchema,
  ImageGenerationSchema,
  EnteredReviewModeSchema,
  ExitedReviewModeSchema,
  ContextCompactionSchema,
])
const knownThreadItemTypes = new Set<string>(
  KnownThreadItemSchema.options.map((schema) => schema.shape.type.value),
)
const UnknownThreadItemSchema = ItemEnvelopeSchema.refine(
  ({ type }) => !knownThreadItemTypes.has(type),
  'known Codex item has an invalid payload',
).transform(({ type, id }) => ({
  type: 'unknown' as const,
  wireType: type,
  ...(id === undefined ? {} : { id }),
}))

/** Runtime projection of the Codex item fields this adapter consumes. */
export const CodexThreadItemSchema = z.union([KnownThreadItemSchema, UnknownThreadItemSchema])
export type CodexThreadItem = z.infer<typeof CodexThreadItemSchema>

/** Translate a Codex thread item into the provider-neutral transcript model. */
export function mapThreadItem(
  item: CodexThreadItem,
  context: { turnId: string; status: ItemStatus; createdAt: number },
): Item {
  const base = {
    id: item.id ?? crypto.randomUUID(),
    turnId: context.turnId,
    status: context.status,
    createdAt: context.createdAt,
  }

  switch (item.type) {
    case 'userMessage':
      return { ...base, type: 'message', role: 'user', text: userInputToText(item.content) }

    case 'hookPrompt':
      return { ...base, type: 'tool_call', text: 'hook prompt' }

    case 'agentMessage':
      return {
        ...base,
        type: 'message',
        role: 'assistant',
        ...(item.phase === null ? {} : { phase: item.phase }),
        text: item.text,
      }

    case 'reasoning':
      return {
        ...base,
        type: 'reasoning',
        text: [...item.summary, ...item.content].join('\n\n'),
      }

    case 'plan':
      return { ...base, type: 'plan', text: item.text }

    case 'commandExecution':
      return {
        ...base,
        type: 'command',
        command: item.command,
        ...(item.aggregatedOutput === null ? {} : { text: item.aggregatedOutput }),
        ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
        ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
      }

    case 'fileChange': {
      const first = item.changes[0]
      return {
        ...base,
        type: 'file_change',
        ...(first ? { path: first.path } : {}),
        text: `${item.changes.length} file(s) changed`,
      }
    }

    case 'mcpToolCall':
      return {
        ...base,
        type: 'tool_call',
        text: `${item.server}.${item.tool}`,
        ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
      }

    case 'dynamicToolCall':
      return {
        ...base,
        type: 'tool_call',
        text: item.tool,
        ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
      }

    case 'collabAgentToolCall': {
      const failed = failedAgentCount(item)
      const targets = new Set([...item.receiverThreadIds, ...Object.keys(item.agentsStates)]).size
      const status: ItemStatus =
        item.status === 'failed' || failed > 0
          ? 'failed'
          : item.status === 'inProgress'
            ? 'started'
            : 'completed'
      return {
        ...base,
        type: 'tool_call',
        status,
        text: collabAgentLabel(item.tool, status, targets, failed),
      }
    }

    case 'subAgentActivity':
      return {
        ...base,
        type: 'tool_call',
        status: item.kind === 'interrupted' ? 'failed' : context.status,
        text:
          item.kind === 'started'
            ? 'Subagent started'
            : item.kind === 'interrupted'
              ? 'Subagent interrupted'
              : 'Subagent active',
      }

    case 'webSearch':
      return { ...base, type: 'tool_call', text: 'web search' }

    case 'imageView': {
      const name = path.win32.basename(path.posix.basename(item.path))
      return {
        ...base,
        type: 'tool_call',
        text: name ? `image view\n${name}` : 'image view',
      }
    }

    case 'sleep':
      return { ...base, type: 'tool_call', text: 'sleep', durationMs: item.durationMs }

    case 'imageGeneration':
      return { ...base, type: 'tool_call', text: 'image generation' }
    case 'enteredReviewMode':
      return { ...base, type: 'tool_call', text: 'enter review mode' }
    case 'exitedReviewMode':
      return { ...base, type: 'tool_call', text: 'exit review mode' }
    case 'contextCompaction':
      return { ...base, type: 'tool_call', text: 'context compaction' }
    case 'unknown':
      return { ...base, type: 'unknown', text: `[${item.wireType}]` }
  }
}

function failedAgentCount(item: Extract<CodexThreadItem, { type: 'collabAgentToolCall' }>): number {
  return Object.values(item.agentsStates).filter(
    (state) =>
      state?.status === 'errored' ||
      state?.status === 'notFound' ||
      state?.status === 'interrupted',
  ).length
}

function collabAgentLabel(
  tool: Extract<CodexThreadItem, { type: 'collabAgentToolCall' }>['tool'],
  status: ItemStatus,
  targets: number,
  failed: number,
): string {
  if (failed > 0) {
    return targets > 1 ? `${failed} of ${targets} subagents failed` : 'Subagent failed'
  }

  const plural = targets > 1
  switch (tool) {
    case 'spawnAgent':
      if (status === 'failed') return 'Could not spawn a subagent'
      if (status === 'started') return plural ? 'Spawning subagents' : 'Spawning a subagent'
      return plural ? `Spawned ${targets} subagents` : 'Spawned a subagent'
    case 'wait':
      if (status === 'failed') return 'Subagent wait failed'
      if (status === 'started') return 'Waiting for subagents'
      return plural ? `${targets} subagents finished` : 'Subagent finished'
    case 'sendInput':
      return status === 'started' ? 'Sending input to a subagent' : 'Sent input to a subagent'
    case 'resumeAgent':
      return status === 'started' ? 'Resuming a subagent' : 'Resumed a subagent'
    case 'closeAgent':
      return status === 'started' ? 'Closing a subagent' : 'Closed a subagent'
  }
}

function userInputToText(content: Array<{ type: string; text?: string | undefined }>): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}
