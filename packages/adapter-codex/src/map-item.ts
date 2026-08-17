import path from 'node:path'
import type { Item, ItemStatus } from '@harness/contracts'
import type { JsonRpcValue } from '@harness/proc'
import { z } from 'zod'
import { propertiesWhen } from './properties-when.js'

const ItemEnvelopeSchema = z.object({ type: z.string(), id: z.string().optional() })
const UserMessageSchema = z.object({
  type: z.literal('userMessage'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})
const AgentMessageSchema = z.object({
  type: z.literal('agentMessage'),
  text: z.string(),
  phase: z.enum(['commentary', 'final_answer']).nullable(),
})
const ReasoningSchema = z.object({
  type: z.literal('reasoning'),
  summary: z.array(z.string()),
  content: z.array(z.string()),
})
const TextItemSchema = z.object({ type: z.string(), text: z.string() })
const CommandSchema = z.object({
  type: z.literal('commandExecution'),
  command: z.string(),
  aggregatedOutput: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
})
const FileChangeSchema = z.object({
  type: z.literal('fileChange'),
  changes: z.array(z.object({ path: z.string() })),
})
const McpToolCallSchema = z.object({
  type: z.literal('mcpToolCall'),
  server: z.string(),
  tool: z.string(),
  durationMs: z.number().nullable(),
})
const DynamicToolCallSchema = z.object({
  type: z.literal('dynamicToolCall'),
  tool: z.string(),
  durationMs: z.number().nullable(),
})
const CollabAgentSchema = z.object({
  type: z.literal('collabAgentToolCall'),
  tool: z.enum(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent']),
  status: z.enum(['inProgress', 'completed', 'failed']),
  receiverThreadIds: z.array(z.string()),
  agentsStates: z.record(
    z.string(),
    z.object({
      status: z.enum([
        'pendingInit',
        'running',
        'interrupted',
        'completed',
        'errored',
        'shutdown',
        'notFound',
      ]),
    }),
  ),
})
const SubAgentActivitySchema = z.object({
  type: z.literal('subAgentActivity'),
  kind: z.enum(['started', 'interacted', 'interrupted']),
})
const ImageViewSchema = z.object({ type: z.literal('imageView'), path: z.string() })
const SleepSchema = z.object({ type: z.literal('sleep'), durationMs: z.number() })

/** Translate a Codex thread item into the provider-neutral transcript model. */
export function mapThreadItem(
  value: JsonRpcValue,
  context: { turnId: string; status: ItemStatus; createdAt: number },
): Item {
  const envelope = ItemEnvelopeSchema.parse(value)
  const base = {
    id: envelope.id ?? crypto.randomUUID(),
    turnId: context.turnId,
    status: context.status,
    createdAt: context.createdAt,
  }

  switch (envelope.type) {
    case 'userMessage': {
      const item = UserMessageSchema.parse(value)
      return { ...base, type: 'message', role: 'user', text: userInputToText(item.content) }
    }

    case 'hookPrompt':
      return { ...base, type: 'tool_call', text: 'hook prompt' }

    case 'agentMessage': {
      const item = AgentMessageSchema.parse(value)
      return {
        ...base,
        type: 'message',
        role: 'assistant',
        ...propertiesWhen(item.phase, (phase) => ({ phase })),
        text: item.text,
      }
    }

    case 'reasoning': {
      const item = ReasoningSchema.parse(value)
      return {
        ...base,
        type: 'reasoning',
        text: [...item.summary, ...item.content].join('\n\n'),
      }
    }

    case 'plan': {
      const item = TextItemSchema.parse(value)
      return { ...base, type: 'plan', text: item.text }
    }

    case 'commandExecution': {
      const item = CommandSchema.parse(value)
      return {
        ...base,
        type: 'command',
        command: item.command,
        ...propertiesWhen(item.aggregatedOutput, (text) => ({ text })),
        ...propertiesWhen(item.exitCode, (exitCode) => ({ exitCode })),
        ...propertiesWhen(item.durationMs, (durationMs) => ({ durationMs })),
      }
    }

    case 'fileChange': {
      const item = FileChangeSchema.parse(value)
      const first = item.changes[0]
      return {
        ...base,
        type: 'file_change',
        ...propertiesWhen(first, ({ path }) => ({ path })),
        text: `${item.changes.length} file(s) changed`,
      }
    }

    case 'mcpToolCall': {
      const item = McpToolCallSchema.parse(value)
      return {
        ...base,
        type: 'tool_call',
        text: `${item.server}.${item.tool}`,
        ...propertiesWhen(item.durationMs, (durationMs) => ({ durationMs })),
      }
    }

    case 'dynamicToolCall': {
      const item = DynamicToolCallSchema.parse(value)
      return {
        ...base,
        type: 'tool_call',
        text: item.tool,
        ...propertiesWhen(item.durationMs, (durationMs) => ({ durationMs })),
      }
    }

    case 'collabAgentToolCall': {
      const item = CollabAgentSchema.parse(value)
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

    case 'subAgentActivity': {
      const item = SubAgentActivitySchema.parse(value)
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
    }

    case 'webSearch':
      return { ...base, type: 'tool_call', text: 'web search' }

    case 'imageView': {
      const item = ImageViewSchema.parse(value)
      const name = path.win32.basename(path.posix.basename(item.path))
      return {
        ...base,
        type: 'tool_call',
        text: name ? `image view\n${name}` : 'image view',
      }
    }

    case 'sleep': {
      const item = SleepSchema.parse(value)
      return { ...base, type: 'tool_call', text: 'sleep', durationMs: item.durationMs }
    }

    case 'imageGeneration':
      return { ...base, type: 'tool_call', text: 'image generation' }
    case 'enteredReviewMode':
      return { ...base, type: 'tool_call', text: 'enter review mode' }
    case 'exitedReviewMode':
      return { ...base, type: 'tool_call', text: 'exit review mode' }
    case 'contextCompaction':
      return { ...base, type: 'tool_call', text: 'context compaction' }
    default:
      return { ...base, type: 'unknown', text: `[${envelope.type}]` }
  }
}

function failedAgentCount(item: z.infer<typeof CollabAgentSchema>): number {
  return Object.values(item.agentsStates).filter(
    ({ status }) => status === 'errored' || status === 'notFound' || status === 'interrupted',
  ).length
}

function collabAgentLabel(
  tool: z.infer<typeof CollabAgentSchema>['tool'],
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
