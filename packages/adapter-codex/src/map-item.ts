import path from 'node:path'
import type { Item, ItemStatus } from '@harness/contracts'
import { z } from 'zod'
import { jsonWithoutBinary } from './binary-content.js'

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
/** Lifecycle states the wire reports on tool-like items; anything else is left to the envelope. */
const WireStatusSchema = z.string().optional()
const CommandSchema = z.object({
  type: z.literal('commandExecution'),
  id: z.string().optional(),
  command: z.string(),
  status: WireStatusSchema,
  aggregatedOutput: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
})
const FileChangeSchema = z.object({
  type: z.literal('fileChange'),
  id: z.string().optional(),
  status: WireStatusSchema,
  changes: z.array(
    z.object({
      path: z.string(),
      kind: z.object({ type: z.string(), move_path: z.string().nullable().optional() }).optional(),
      diff: z.string().optional(),
    }),
  ),
})
const McpToolCallSchema = z.object({
  type: z.literal('mcpToolCall'),
  id: z.string().optional(),
  server: z.string(),
  tool: z.string(),
  status: WireStatusSchema,
  arguments: z.unknown().optional(),
  result: z
    .object({ content: z.array(z.unknown()).optional(), structuredContent: z.unknown().optional() })
    .nullable()
    .optional(),
  error: z.object({ message: z.string() }).nullable().optional(),
  durationMs: z.number().nullable(),
})
const DynamicToolCallSchema = z.object({
  type: z.literal('dynamicToolCall'),
  id: z.string().optional(),
  namespace: z.string().nullable().optional(),
  tool: z.string(),
  status: WireStatusSchema,
  arguments: z.unknown().optional(),
  contentItems: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .nullable()
    .optional(),
  success: z.boolean().nullable().optional(),
  durationMs: z.number().nullable(),
})
const CollabAgentSchema = z.object({
  type: z.literal('collabAgentToolCall'),
  id: z.string().optional(),
  tool: z.enum(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent']),
  status: z.enum(['inProgress', 'completed', 'failed']),
  prompt: z.string().nullable().optional(),
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
const WebSearchSchema = z.object({
  type: z.literal('webSearch'),
  id: z.string().optional(),
  query: z.string().optional(),
})
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

/**
 * Translate a Codex thread item into the provider-neutral transcript model.
 *
 * Tool activity keeps the transcript's text convention so the renderer can
 * read every provider the same way: the first line names the tool, an
 * optional JSON line carries its arguments, and whatever follows is output.
 * File changes carry a unified diff, like the replayed history does.
 */
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
        status: wireStatus(item.status, context.status),
        type: 'command',
        command: item.command,
        ...(item.aggregatedOutput === null ? {} : { text: item.aggregatedOutput }),
        ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
        ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
      }

    case 'fileChange': {
      const first = item.changes[0]
      const diff = item.changes.map(unifiedDiff).join('\n')
      return {
        ...base,
        status: wireStatus(item.status, context.status),
        type: 'file_change',
        ...(first ? { path: first.path } : {}),
        text: diff || `${item.changes.length} file(s) changed`,
        linesAdded: countDiffLines(diff, '+'),
        linesRemoved: countDiffLines(diff, '-'),
      }
    }

    case 'mcpToolCall':
      return {
        ...base,
        status: wireStatus(item.error ? 'failed' : item.status, context.status),
        type: 'tool_call',
        text: toolCallText(
          `${item.server}.${item.tool}`,
          item.arguments,
          item.error?.message ?? readable(item.result?.content ?? item.result?.structuredContent),
        ),
        ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
      }

    case 'dynamicToolCall':
      return {
        ...base,
        status: wireStatus(item.success === false ? 'failed' : item.status, context.status),
        type: 'tool_call',
        text: toolCallText(
          item.tool,
          item.arguments,
          item.contentItems
            ?.map((part) => (part.type === 'inputImage' ? '[image]' : (part.text ?? '')))
            .filter(Boolean)
            .join('\n'),
        ),
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
        text: toolCallText(
          collabAgentLabel(item.tool, status, targets, failed),
          undefined,
          item.prompt,
        ),
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
      return {
        ...base,
        type: 'tool_call',
        text: toolCallText('web search', item.query ? { query: item.query } : undefined, undefined),
      }

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

/**
 * The envelope only says started or completed; the item itself knows whether
 * the tool failed or the user declined it. Both read as a failure to the user.
 */
function wireStatus(status: string | undefined, fallback: ItemStatus): ItemStatus {
  if (fallback === 'started') return 'started'
  return status === 'failed' || status === 'declined' ? 'failed' : fallback
}

function toolCallText(name: string, args: unknown, output: string | null | undefined): string {
  const argumentLine =
    args !== undefined && args !== null && !(typeof args === 'object' && isEmpty(args))
      ? JSON.stringify(args)
      : undefined
  return [name, argumentLine, output?.trim() || undefined].filter(Boolean).join('\n')
}

function isEmpty(value: object): boolean {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0
}

/** Text carried by MCP result content parts, falling back to compact JSON. */
function readable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof part === 'object' &&
              part !== null &&
              typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : jsonWithoutBinary(part),
      )
      .filter(Boolean)
    return parts.length ? parts.join('\n') : undefined
  }
  return jsonWithoutBinary(value, 2)
}

/** One file of a Codex patch as the git-style unified diff the transcript renders. */
function unifiedDiff(change: {
  path: string
  kind?: { type: string; move_path?: string | null | undefined } | undefined
  diff?: string | undefined
}): string {
  const kind = change.kind?.type ?? 'update'
  const target = change.kind?.move_path ?? change.path
  const body = (change.diff ?? '').replace(/\n$/, '')
  if (body.startsWith('diff --git')) return body
  const header = [
    `diff --git a/${change.path} b/${target}`,
    `--- ${kind === 'add' ? '/dev/null' : `a/${change.path}`}`,
    `+++ ${kind === 'delete' ? '/dev/null' : `b/${target}`}`,
  ]
  return body ? `${header.join('\n')}\n${body}` : header.join('\n')
}

function countDiffLines(diff: string, marker: '+' | '-'): number {
  let count = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false
    else if (line.startsWith('@@')) inHunk = true
    else if (line.startsWith(marker) && (inHunk || !line.startsWith(marker.repeat(3)))) count += 1
  }
  return count
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
